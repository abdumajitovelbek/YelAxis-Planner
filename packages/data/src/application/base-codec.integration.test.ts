import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createActionApplication,
  createPlanningApplication,
  type ApplicationDependencies,
  type ApplicationResult,
  type CommandReceipt,
} from '@yelaxis/application';
import type { Instant, OwnerId, UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteActionPlanningQueries } from '../queries/action-planning';
import { SqlitePlanningQueries } from '../queries/planning-queries';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { createSqliteApplicationAdapters } from './sqlite-adapters';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const redacted =
  '{"commandType":"redacted_for_permanent_delete","payload":{},"expectedRevisions":{}}';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-base-codec-'));
  temporaryDirectories.push(directory);
  const now = '2026-10-05T12:00:00.000Z' as Instant;
  let counter = 1;
  const ids = {
    next() {
      const suffix = counter.toString(16).padStart(12, '0');
      counter += 1;
      return `90000000-0000-4000-8000-${suffix}` as UUID;
    },
  };
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
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
     ) VALUES ('11000000-0000-4000-8000-000000000001', ?, 'America/New_York', 'monday',
               '24_hour', 'en', 'completed', 'handbook', ?, ?);`,
    [ownerId, now, now],
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
    planning: createPlanningApplication(dependencies, new SqlitePlanningQueries(driver)),
    actions: createActionApplication(dependencies, new SqliteActionPlanningQueries(driver)),
  };
}

function receipt(result: ApplicationResult<CommandReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('BaseCodec permanent delete', () => {
  it('redacts applied undo descriptors that still hold the deleted placement document', async () => {
    const { driver, planning, actions } = await fixture();
    const intent = actions.newCaptureIntent('inbox');
    receipt(await actions.capture(intent, { title: 'Private errand' }));
    const revisionOf = async () => {
      const detail = await actions.getAction(intent.actionId);
      if (detail === null) throw new Error('Missing action');
      return detail.action.localRevision;
    };
    receipt(
      await planning.place({
        target: { kind: 'action', id: intent.actionId, revision: await revisionOf() },
        period: { kind: 'week', date: '2026-10-05' },
      }),
    );
    const moved = receipt(
      await planning.place({
        target: { kind: 'action', id: intent.actionId, revision: await revisionOf() },
        period: { kind: 'week', date: '2026-10-12' },
      }),
    );
    if (!moved.undo.available) throw new Error('Expected an undo receipt.');
    receipt(await planning.undo(moved.undo.undoId));
    const placement = await driver.get<{ id: string }>(
      'SELECT id FROM planning_placements WHERE action_id = ?;',
      [intent.actionId],
    );
    if (placement === undefined) throw new Error('Missing placement');
    const referencing = await driver.all<{ id: string; state: string }>(
      `SELECT id, state FROM undo_records WHERE descriptor_payload_json LIKE ?;`,
      [`%${placement.id}%`],
    );
    expect(referencing.some((row) => row.state === 'applied')).toBe(true);

    receipt(await actions.deletePermanently(intent.actionId, await revisionOf(), 'Private errand'));

    const remaining = await driver.all<{ id: string }>(
      `SELECT id FROM undo_records
       WHERE descriptor_payload_json LIKE ? OR descriptor_payload_json LIKE ?;`,
      [`%${placement.id}%`, `%${intent.actionId}%`],
    );
    expect(remaining).toEqual([]);
    for (const row of referencing) {
      await expect(
        driver.get<{ state: string; descriptor_payload_json: string }>(
          'SELECT state, descriptor_payload_json FROM undo_records WHERE id = ?;',
          [row.id],
        ),
      ).resolves.toEqual({ state: 'expired', descriptor_payload_json: redacted });
    }
    await driver.close();
  });
});
