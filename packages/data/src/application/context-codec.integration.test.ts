import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CanonicalMutation } from '@yelaxis/application';
import type { CommandContext, EntityRef, Instant, OwnerId, UUID } from '@yelaxis/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { contextDocumentSchema } from './context-codec';
import { createSqliteApplicationAdapters } from './sqlite-adapters';

/*
 * account sync context record codec: a row written by onboarding setup decodes to the canonical
 * document that syncs and exports, and creates and updates round-trip through the record repository.
 */

const now = '2026-10-01T09:00:00.000Z' as Instant;
const ownerId = '10000000-0000-4000-8000-0000000000c1' as OwnerId;
const setupContextId = '30000000-0000-4000-8000-0000000000c1' as UUID;
const newContextId = '30000000-0000-4000-8000-0000000000c2' as UUID;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-context-codec-'));
  temporaryDirectories.push(directory);
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  await runMigrations(driver, schemaMigrations, () => now);
  await driver.run(
    `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
     VALUES (?, 'local', ?, ?);`,
    [ownerId, now, now],
  );
  // The shape onboarding setup writes directly.
  await driver.run(
    `INSERT INTO contexts (
       id, owner_id, category, context_key, value_text, source, sensitivity, strength,
       future_sharing_state, state, created_at, updated_at, client_updated_at
     ) VALUES (?, ?, 'boundaries', 'protected_boundary', 'No calls after 19:00', 'user',
               'sensitive', 'hard', 'not_shared', 'active', ?, ?, ?);`,
    [setupContextId, ownerId, now, now, now],
  );
  const adapters = createSqliteApplicationAdapters(driver, { ownerId });
  const context: CommandContext = {
    ownerId,
    actor: 'user',
    commandId: '40000000-0000-4000-8000-0000000000c1' as CommandContext['commandId'],
    now,
  };
  const read = (target: EntityRef) =>
    adapters.unitOfWork.runInTransaction((work) => work.records.read(target));
  const apply = (mutation: CanonicalMutation) =>
    adapters.unitOfWork.runInTransaction((work) => work.records.apply(mutation, context));
  return { driver, read, apply };
}

const ref = (id: UUID): EntityRef<'context'> => ({ type: 'context', id, ownerId });

describe('the context record codec', () => {
  it('decodes a row written by setup into the canonical document', async () => {
    const { read } = await fixture();
    const record = await read(ref(setupContextId));
    expect(record?.document).toEqual({
      category: 'boundaries',
      contextKey: 'protected_boundary',
      value: 'No calls after 19:00',
      source: 'user',
      sensitivity: 'sensitive',
      strength: 'hard',
      futureSharing: 'not_shared',
      state: 'active',
    });
    expect(contextDocumentSchema.safeParse(record?.document).success).toBe(true);
  });

  it('creates, updates, and archives a context through the record repository', async () => {
    const { read, apply, driver } = await fixture();
    const document = {
      category: 'preferences',
      contextKey: 'focus_hours',
      value: 'Mornings',
      source: 'user',
      sensitivity: 'normal',
      strength: 'soft',
      futureSharing: 'not_shared',
      state: 'active',
    };
    await apply({
      operation: 'create',
      ref: ref(newContextId),
      expectedRevision: null,
      baseServerRevision: 0,
      baseSnapshotHash: null,
      document,
    });
    const created = await read(ref(newContextId));
    expect(created?.document).toEqual(document);
    if (created === null) throw new Error('Missing context.');
    await apply({
      operation: 'update',
      ref: created.ref,
      expectedRevision: created.localRevision,
      baseServerRevision: created.serverRevision,
      baseSnapshotHash: created.baseSnapshotHash,
      document: { ...document, state: 'archived', stateBeforeArchive: 'active', archivedAt: now },
    });
    await expect(
      driver.get<Readonly<Record<string, unknown>>>(
        'SELECT state, state_before_archive, archived_at, future_sharing_state FROM contexts WHERE id = ?;',
        [newContextId],
      ),
    ).resolves.toEqual({
      state: 'archived',
      state_before_archive: 'active',
      archived_at: now,
      future_sharing_state: 'not_shared',
    });
  });

  it('refuses a sharing state other than not_shared and unknown fields', () => {
    const base = {
      category: 'goals',
      contextKey: 'year_goal',
      value: 'Run a 5K',
      source: 'user',
      sensitivity: 'normal',
      strength: 'soft',
      futureSharing: 'not_shared',
      state: 'active',
    };
    expect(contextDocumentSchema.safeParse(base).success).toBe(true);
    expect(contextDocumentSchema.safeParse({ ...base, futureSharing: 'shared' }).success).toBe(
      false,
    );
    expect(contextDocumentSchema.safeParse({ ...base, ownerId }).success).toBe(false);
  });
});
