import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createActionApplication,
  createOnboardingApplication,
  createPlanningApplication,
  type ApplicationDependencies,
  type OnboardingApplication,
  type OnboardingArtifacts,
  type OnboardingState,
} from '@yelaxis/application';
import type { EntityType, Instant, OnboardingDraft, OwnerId, UUID } from '@yelaxis/domain';
import { expect } from 'vitest';

import { SqliteActionPlanningQueries } from '../../queries/action-planning';
import { SqlitePlanningQueries } from '../../queries/planning-queries';
import { schemaMigrations } from '../../sqlite/migrations';
import { runMigrations } from '../../sqlite/migrations/migration';
import { NodeSqliteDriver } from '../../sqlite/testing/node-driver.node';
import { SqliteOnboardingPersistence } from '../onboarding-adapter';
import { createSqliteApplicationAdapters } from '../sqlite-adapters';

/**
 * Real-SQLite onboarding fixture for rerun regression tests: setup completes at noon in Tashkent on
 * Thursday 2026-08-06, in the Sunday week 2026-08-02..2026-08-08.
 */
export const setupDay = '2026-08-06T07:00:00.000Z' as Instant;

export const onboardingDefaults = {
  planningTimeZone: 'Asia/Tashkent',
  weekStart: 'sunday' as const,
  timeFormat: '24_hour' as const,
  locale: 'en',
};

export const starterActionTitle = 'Draft the proposal outline';

export function setupDraft(): OnboardingDraft {
  return {
    identity: { preferredName: 'Sam', locale: 'en' },
    defaults: onboardingDefaults,
    context: {},
    axes: ['Study'],
    outcome: {
      title: 'Submit a clear proposal',
      successDefinition: 'The reviewer can decide without asking for missing information.',
      axisIndex: 0,
    },
    week: { commitments: [], actionTitle: starterActionTitle },
  };
}

const temporaryDirectories: string[] = [];

/** Call from `afterEach`. */
export async function removeOnboardingFixtures(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
}

export type OnboardingFixture = Awaited<ReturnType<typeof openOnboardingFixture>>;

/** The account identity of `openOnboardingFixture({ identity: 'account' })`. */
export const accountOwnerId = '40000000-0000-4000-8000-0000000000ac' as OwnerId;

/**
 * A migrated database with an initialized, not yet completed, onboarding Profile. With
 * `identity: 'account'` the plan belongs to an account identity (sync enabled) from the start;
 * the ids it generates are the same as for a local identity.
 */
export async function openOnboardingFixture(
  options: Readonly<{ identity?: 'local' | 'account' }> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-onboarding-rerun-'));
  temporaryDirectories.push(directory);
  const driver = new NodeSqliteDriver(join(directory, 'plan.sqlite'));
  let now = setupDay;
  await runMigrations(driver, schemaMigrations, () => now);
  if (options.identity === 'account') {
    await driver.run(
      `INSERT INTO planning_identities (
         id, identity_kind, account_subject_id, replica_id, created_at, updated_at
       ) VALUES (?, 'account', 'subject', '40000000-0000-4000-8000-0000000000ad', ?, ?);`,
      [accountOwnerId, now, now],
    );
  }
  let id = 1;
  const clock = { now: () => now };
  const ids = {
    next: () => {
      const suffix = id.toString(16).padStart(12, '0');
      id += 1;
      return `10000000-0000-4000-8000-${suffix}` as UUID;
    },
  };
  const onboarding = createOnboardingApplication(new SqliteOnboardingPersistence(driver), {
    clock,
    ids,
  });
  const initial = await onboarding.initialize(onboardingDefaults);
  const dependencies = (): ApplicationDependencies => ({
    ...createSqliteApplicationAdapters(driver, { ownerId: initial.ownerId }),
    ids,
    clock,
    projections: { notifyCommitted() {} },
  });
  return {
    driver,
    onboarding,
    initial,
    setNow: (value: Instant) => {
      now = value;
    },
    /** The Action application over the same database, owner, clock, and ids. */
    actions: () => createActionApplication(dependencies(), new SqliteActionPlanningQueries(driver)),
    /** The planning application over the same database, owner, clock, and ids. */
    planning: () => createPlanningApplication(dependencies(), new SqlitePlanningQueries(driver)),
  };
}

export async function complete(
  onboarding: OnboardingApplication,
  draft: OnboardingDraft = setupDraft(),
): Promise<OnboardingState> {
  const result = await onboarding.execute({ kind: 'complete', draft, handbookStatus: 'skipped' });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/** Reruns setup and saves it again with the resumed draft, as the web flow does. */
export async function rerun(
  onboarding: OnboardingApplication,
  edit: (draft: OnboardingDraft) => OnboardingDraft = (draft) => draft,
): Promise<OnboardingState> {
  const started = await onboarding.execute({ kind: 'rerun' });
  if (!started.ok) throw new Error(started.message);
  return complete(onboarding, edit(started.value.draft));
}

/** The artifact ids the first completion allocates (the fixture's ids are deterministic). */
export async function firstCompletionArtifacts(): Promise<OnboardingArtifacts> {
  const probe = await openOnboardingFixture();
  const completed = await complete(probe.onboarding);
  await probe.driver.close();
  return completed.artifacts;
}

/** Records a permanent deletion, as the Action/alignment delete commands do. */
export async function ledgerDeletion(
  driver: NodeSqliteDriver,
  ownerId: OwnerId,
  type: EntityType,
  entityId: string,
): Promise<void> {
  await driver.run(
    `INSERT INTO deletion_ledger (id, owner_id, entity_type, entity_id, local_revision,
       deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?);`,
    [`${ownerId}:${type}:${entityId}`, ownerId, type, entityId, setupDay, setupDay, setupDay],
  );
}

export async function rows(
  driver: NodeSqliteDriver,
  table: 'planning_placements' | 'focus_selections' | 'week_selections' | 'time_blocks',
): Promise<Record<string, unknown>[]> {
  return driver.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY id;`);
}

/** Onboarding events for one record kind, optionally for one entity. */
export async function onboardingEventCount(
  driver: NodeSqliteDriver,
  kind: 'placement' | 'focus' | 'week_selection',
  entityId?: string,
): Promise<number> {
  const row = await driver.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM domain_events
     WHERE event_type = ? AND (? IS NULL OR entity_id = ?);`,
    [`onboarding.${kind}.saved`, entityId ?? null, entityId ?? null],
  );
  return row?.count ?? -1;
}

export type OnboardingReceipt = Readonly<{
  commandId: string;
  canonical: readonly Readonly<{ ref: Readonly<{ type: string; id: string }> }>[];
  eventIds: readonly string[];
}>;

export async function latestReceipt(driver: NodeSqliteDriver): Promise<OnboardingReceipt> {
  const row = await driver.get<{ receipt_payload_json: string }>(
    'SELECT receipt_payload_json FROM command_receipts ORDER BY rowid DESC LIMIT 1;',
  );
  if (row === undefined) throw new Error('Missing receipt');
  return JSON.parse(row.receipt_payload_json) as OnboardingReceipt;
}

/** The receipt names exactly the events written for its command, in sequence order. */
export async function expectReceiptMatchesEvents(
  driver: NodeSqliteDriver,
  receipt: OnboardingReceipt,
): Promise<void> {
  const events = await driver.all<{ id: string; sequence: number }>(
    'SELECT id, sequence FROM domain_events WHERE command_id = ? ORDER BY sequence;',
    [receipt.commandId],
  );
  expect(events.map(({ id }) => id)).toEqual(receipt.eventIds);
  expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_, index) => index));
  expect(receipt.canonical).toHaveLength(events.length);
}
