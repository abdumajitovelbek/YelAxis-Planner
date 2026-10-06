import {
  sameDocument,
  type CanonicalMutation,
  type CanonicalRecordState,
  type OnboardingArtifacts,
  type OnboardingCommit,
  type OnboardingPersistencePort,
  type OnboardingRecordMutation,
  type OnboardingState,
  type OutboxOperation,
  type SyncQueueReceipt,
} from '@yelaxis/application';
import {
  createEntityRef,
  emptyOnboardingDraft,
  entityRefKey,
  onboardingSteps,
  validateOnboardingDraft,
  validateOnboardingStep,
  type Instant,
  type EntityRef,
  type EntityRefKey,
  type EntityType,
  type OnboardingDraft,
  type OnboardingStep,
  type OwnerId,
  type ProfileId,
  type UUID,
  type Weekday,
} from '@yelaxis/domain';
import { z } from 'zod';

import type { SqliteDriver, SqliteParameter, SqliteTransaction } from '../sqlite/driver';
import {
  type CanonicalCodecRegistry,
  createDefaultCanonicalCodecRegistry,
} from './canonical-codecs';
import { DataAdapterError } from './errors';
import { bindPlanningUnitOfWork } from './sqlite-adapters';

const uuid = z.uuid();
const step = z.enum(onboardingSteps);
const steps = z.array(step).refine((value) => new Set(value).size === value.length);
const artifactsSchema = z.strictObject({
  axisIds: z.array(uuid).max(3).default([]),
  outcomeId: uuid.optional(),
  actionId: uuid.optional(),
  placementId: uuid.optional(),
  focusId: uuid.optional(),
  weekSelectionId: uuid.optional(),
  awakeContextId: uuid.optional(),
  availabilityContextId: uuid.optional(),
  availabilityConstraintId: uuid.optional(),
  boundaryContextId: uuid.optional(),
  commitments: z
    .array(z.strictObject({ commitmentId: uuid, timeBlockId: uuid }))
    .max(3)
    .default([]),
});

type ProfileRow = Readonly<{
  id: string;
  owner_id: string;
  preferred_name: string | null;
  planning_time_zone: string | null;
  week_start: string | null;
  time_format: '12_hour' | '24_hour' | null;
  locale_override: string | null;
  defaults_confirmed_at: string | null;
  local_revision: number;
  onboarding_status: 'not_started' | 'in_progress' | 'completed';
  onboarding_step: OnboardingStep;
  onboarding_completed_steps_json: string;
  onboarding_skipped_steps_json: string;
  onboarding_draft_json: string | null;
  onboarding_artifacts_json: string;
  onboarding_completed_at: string | null;
  handbook_status: 'not_started' | 'in_progress' | 'skipped' | 'completed';
  handbook_lesson: number;
  handbook_completed_lessons_json: string;
}>;

type AppliedCanonical = Readonly<{
  type: EntityType;
  id: UUID;
  localRevision: number;
}>;

/** A record this commit wrote, with the event id the application allocated for it. */
type WrittenRecord = Readonly<{ mutation: OnboardingRecordMutation; eventId: UUID }>;

/**
 * The Profile or a record an account identity's commit may write, with the outbox operation id the
 * application allocated for it and its canonical state before the commit wrote anything.
 */
type ReplicatedRecord = Readonly<{
  ref: EntityRef;
  operationId: UUID;
  before: CanonicalRecordState | null;
}>;

/** The starter Action's day, focus, and week records: inserted with a new starter Action only. */
type StarterPlanMutation = Extract<
  OnboardingRecordMutation,
  { kind: 'placement' | 'focus' | 'week_selection' }
>;

/** Day focus is limited to three active items (trg_focus_max_three_insert). */
const dayFocusLimit = 3;

const profileColumns = `
  id, owner_id, preferred_name, planning_time_zone, week_start, time_format, locale_override,
  defaults_confirmed_at, local_revision, onboarding_status, onboarding_step,
  onboarding_completed_steps_json, onboarding_skipped_steps_json, onboarding_draft_json,
  onboarding_artifacts_json, onboarding_completed_at, handbook_status, handbook_lesson,
  handbook_completed_lessons_json
`;

export class SqliteOnboardingPersistence implements OnboardingPersistencePort {
  private readonly codecs = createDefaultCanonicalCodecRegistry();

  constructor(private readonly driver: SqliteDriver) {}

  async initialize(
    input: Parameters<OnboardingPersistencePort['initialize']>[0],
  ): Promise<OnboardingState> {
    const active = await this.driver.all<{ id: string }>(
      `SELECT id FROM planning_identities WHERE deleted_at IS NULL ORDER BY created_at, id LIMIT 2;`,
    );
    if (active.length > 1) throw new DataAdapterError('identity_ambiguous');
    if (active.length === 1) {
      const existing = await this.load();
      if (existing !== null) {
        if (existing.ownerId !== active[0]?.id)
          throw new DataAdapterError('invalid_identity_record');
        // Opening an already initialized plan changes no canonical row and needs no durable write.
        return existing;
      }
    }
    await this.driver.transaction(async (transaction) => {
      const identities = await transaction.all<{ id: string }>(
        `SELECT id FROM planning_identities WHERE deleted_at IS NULL ORDER BY created_at, id LIMIT 2;`,
      );
      if (identities.length > 1) throw new DataAdapterError('identity_ambiguous');
      const existingOwner = identities[0]?.id;
      const ownerId = existingOwner ?? input.ownerId;
      if (existingOwner === undefined) {
        await assertOne(
          transaction.run(
            `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
           VALUES (?, 'local', ?, ?);`,
            [ownerId, input.now, input.now],
          ),
        );
      }
      const profile = await transaction.get<{ id: string }>(
        `SELECT id FROM profiles WHERE owner_id = ? AND deleted_at IS NULL;`,
        [ownerId],
      );
      if (profile === undefined) {
        if (input.defaults === null) throw new DataAdapterError('invalid_persisted_record');
        const initialDraft: OnboardingDraft = {
          ...emptyOnboardingDraft(),
          identity: { preferredName: '', locale: input.defaults.locale },
          defaults: input.defaults,
        };
        await assertOne(
          transaction.run(
            `INSERT INTO profiles (
             id, owner_id, planning_time_zone, week_start, time_format, locale_override,
             onboarding_draft_json, onboarding_artifacts_json, created_at, updated_at,
             client_updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [
              input.profileId,
              ownerId,
              input.defaults.planningTimeZone,
              input.defaults.weekStart,
              input.defaults.timeFormat,
              input.defaults.locale,
              JSON.stringify(initialDraft),
              JSON.stringify({ axisIds: [], commitments: [] }),
              input.now,
              input.now,
              input.now,
            ],
          ),
        );
      }
    });
    const state = await this.load();
    if (state === null) throw new DataAdapterError('invalid_identity_record');
    return state;
  }

  async load(): Promise<OnboardingState | null> {
    return loadState(this.driver);
  }

  async commit(command: OnboardingCommit): Promise<OnboardingState> {
    await this.driver.transaction(async (transaction) => {
      const existing = await transaction.get<{ id: string }>(
        `SELECT id FROM command_receipts WHERE owner_id = ? AND command_id = ? AND deleted_at IS NULL;`,
        [command.ownerId, command.commandId],
      );
      if (existing !== undefined) return;
      if (
        command.eventIds.length !== command.records.length + 1 ||
        command.outbox.operationIds.length !== command.records.length + 1
      ) {
        throw new DataAdapterError('write_conflict');
      }
      const identity = await transaction.get<{ identity_kind: string }>(
        `SELECT identity_kind FROM planning_identities WHERE id = ? AND deleted_at IS NULL;`,
        [command.ownerId],
      );
      const identityKind = identity?.identity_kind;
      if (identityKind !== 'local' && identityKind !== 'account') {
        throw new DataAdapterError('write_conflict');
      }
      const current = await transaction.get<{ local_revision: number }>(
        `SELECT local_revision FROM profiles WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
        [command.ownerId, command.profileId],
      );
      if (current?.local_revision !== command.expectedProfileRevision) {
        throw new DataAdapterError('write_conflict');
      }
      // Like every other command, an account identity's commit queues what it changes for the
      // account in this same transaction; a local identity queues nothing.
      const replicated =
        identityKind === 'account'
          ? await readBeforeWrites(transaction, this.codecs, command)
          : null;
      await updateProfile(transaction, command);
      const canonical: AppliedCanonical[] = [
        {
          type: 'profile',
          id: command.profileId,
          localRevision: command.expectedProfileRevision + 1,
        },
      ];
      const written: WrittenRecord[] = [];
      for (const [index, mutation] of command.records.entries()) {
        if (isStarterPlan(mutation)) {
          if (!(await addStarterPlanRecord(transaction, command, mutation))) continue;
        } else {
          await applyRecord(transaction, command, mutation);
        }
        const eventId = command.eventIds[index + 1];
        if (eventId === undefined) throw new DataAdapterError('write_conflict');
        written.push({ mutation, eventId });
        canonical.push(await readAppliedCanonical(transaction, command.ownerId, mutation));
      }
      const sync: SyncQueueReceipt =
        replicated === null
          ? { queued: false }
          : await queueChanges(transaction, this.codecs, command, replicated, canonical);
      await appendEventsAndReceipt(transaction, command, written, canonical, sync);
    });
    const state = await this.load();
    if (state === null) throw new DataAdapterError('invalid_persisted_record');
    return state;
  }
}

async function updateProfile(
  transaction: SqliteTransaction,
  command: OnboardingCommit,
): Promise<void> {
  const profile = command.profile;
  const result = await transaction.run(
    `UPDATE profiles SET
       preferred_name = ?, planning_time_zone = ?, week_start = ?, time_format = ?,
       locale_override = ?, defaults_confirmed_at = ?, onboarding_status = ?,
       onboarding_step = ?, onboarding_completed_steps_json = ?, onboarding_skipped_steps_json = ?,
       onboarding_draft_json = ?, onboarding_artifacts_json = ?, onboarding_completed_at = ?,
       handbook_status = ?, handbook_lesson = ?, handbook_completed_lessons_json = ?,
       updated_at = ?, client_updated_at = ?, local_revision = local_revision + 1
     WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?;`,
    [
      profile.preferredName ?? null,
      profile.planningTimeZone,
      profile.weekStart,
      profile.timeFormat,
      profile.localeOverride ?? null,
      profile.defaultsConfirmedAt ?? null,
      profile.status,
      profile.step,
      JSON.stringify(profile.completedSteps),
      JSON.stringify(profile.skippedSteps),
      profile.draft === null ? null : JSON.stringify(profile.draft),
      JSON.stringify(profile.artifacts),
      profile.completedAt ?? null,
      profile.handbook.status,
      profile.handbook.lesson,
      JSON.stringify(profile.handbook.completedLessons),
      command.now,
      command.now,
      command.ownerId,
      command.profileId,
      command.expectedProfileRevision,
    ],
  );
  if (result.changes !== 1) throw new DataAdapterError('write_conflict');
}

async function applyRecord(
  transaction: SqliteTransaction,
  command: OnboardingCommit,
  mutation: Exclude<OnboardingRecordMutation, StarterPlanMutation>,
): Promise<void> {
  const common = [command.now, command.now, command.now] as const;
  await assertNeverDeleted(transaction, command.ownerId, mutation);
  // A rerun may rename the starter Axes, Outcome, and Action it created, but never changes their
  // order or Axis membership: both may have changed since setup, so on conflict the
  // upserts below leave `sort_key` and `axis_id` of those rows as they are.
  switch (mutation.kind) {
    case 'axis':
      await assertOne(
        transaction.run(
          `INSERT INTO axes (id, owner_id, title, state, sort_key, created_at, updated_at, client_updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title,
           updated_at = excluded.updated_at, client_updated_at = excluded.client_updated_at,
           local_revision = axes.local_revision + 1
         WHERE axes.owner_id = excluded.owner_id AND axes.deleted_at IS NULL;`,
          [mutation.id, command.ownerId, mutation.title, mutation.sortKey, ...common],
        ),
      );
      return;
    case 'outcome':
      await assertOne(
        transaction.run(
          `INSERT INTO outcomes (
           id, owner_id, axis_id, title, success_definition, state, progress_mode,
           target_end_date, sort_key, created_at, updated_at, client_updated_at
         ) VALUES (?, ?, ?, ?, ?, 'active', 'none', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title,
           success_definition = excluded.success_definition, target_end_date = excluded.target_end_date,
           updated_at = excluded.updated_at,
           client_updated_at = excluded.client_updated_at, local_revision = outcomes.local_revision + 1
         WHERE outcomes.owner_id = excluded.owner_id AND outcomes.deleted_at IS NULL;`,
          [
            mutation.id,
            command.ownerId,
            mutation.axisId ?? null,
            mutation.title,
            mutation.successDefinition,
            mutation.targetDate ?? null,
            mutation.sortKey,
            ...common,
          ],
        ),
      );
      return;
    case 'context':
      await assertOne(
        transaction.run(
          `INSERT INTO contexts (
           id, owner_id, category, context_key, value_text, source, sensitivity, strength,
           future_sharing_state, state, created_at, updated_at, client_updated_at
         ) VALUES (?, ?, ?, ?, ?, 'user', 'sensitive', ?, 'not_shared', 'active', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET category = excluded.category, context_key = excluded.context_key,
           value_text = excluded.value_text, strength = excluded.strength,
           updated_at = excluded.updated_at, client_updated_at = excluded.client_updated_at,
           local_revision = contexts.local_revision + 1
         WHERE contexts.owner_id = excluded.owner_id AND contexts.deleted_at IS NULL;`,
          [
            mutation.id,
            command.ownerId,
            mutation.category,
            mutation.contextKey,
            mutation.value,
            mutation.strength,
            ...common,
          ],
        ),
      );
      return;
    case 'constraint':
      await assertOne(
        transaction.run(
          `INSERT INTO constraints (
           id, owner_id, context_id, constraint_kind, strength, value_schema_version,
           value_payload_json, state, created_at, updated_at, client_updated_at
         ) VALUES (?, ?, ?, 'availability', ?, 1, ?, 'active', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET context_id = excluded.context_id, strength = excluded.strength,
           value_payload_json = excluded.value_payload_json, updated_at = excluded.updated_at,
           client_updated_at = excluded.client_updated_at, local_revision = constraints.local_revision + 1
         WHERE constraints.owner_id = excluded.owner_id AND constraints.deleted_at IS NULL;`,
          [
            mutation.id,
            command.ownerId,
            mutation.contextId,
            mutation.strength,
            JSON.stringify(mutation.payload),
            ...common,
          ],
        ),
      );
      return;
    case 'commitment':
      await assertOne(
        transaction.run(
          `INSERT INTO commitments (
           id, owner_id, title, strength, state, created_at, updated_at, client_updated_at
         ) VALUES (?, ?, ?, ?, 'planned', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, strength = excluded.strength,
           updated_at = excluded.updated_at, client_updated_at = excluded.client_updated_at,
           local_revision = commitments.local_revision + 1
         WHERE commitments.owner_id = excluded.owner_id AND commitments.deleted_at IS NULL;`,
          [mutation.id, command.ownerId, mutation.title, mutation.strength, ...common],
        ),
      );
      return;
    case 'time_block':
      await assertOne(
        transaction.run(
          `INSERT INTO time_blocks (
           id, owner_id, commitment_id, starts_at_utc, ends_at_utc, time_zone, state,
           created_at, updated_at, client_updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET commitment_id = excluded.commitment_id,
           starts_at_utc = excluded.starts_at_utc, ends_at_utc = excluded.ends_at_utc,
           time_zone = excluded.time_zone, updated_at = excluded.updated_at,
           client_updated_at = excluded.client_updated_at, local_revision = time_blocks.local_revision + 1
         WHERE time_blocks.owner_id = excluded.owner_id AND time_blocks.deleted_at IS NULL;`,
          [
            mutation.id,
            command.ownerId,
            mutation.commitmentId,
            mutation.startsAtUtc,
            mutation.endsAtUtc,
            mutation.timeZone,
            ...common,
          ],
        ),
      );
      return;
    case 'action':
      await assertOne(
        transaction.run(
          `INSERT INTO actions (
           id, owner_id, axis_id, title, state, capture_origin, sort_key,
           created_at, updated_at, client_updated_at
         ) VALUES (?, ?, ?, ?, 'planned', 'onboarding', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title,
           updated_at = excluded.updated_at,
           client_updated_at = excluded.client_updated_at, local_revision = actions.local_revision + 1
         WHERE actions.owner_id = excluded.owner_id AND actions.deleted_at IS NULL;`,
          [
            mutation.id,
            command.ownerId,
            mutation.axisId ?? null,
            mutation.title,
            mutation.sortKey,
            ...common,
          ],
        ),
      );
      return;
  }
}

function isStarterPlan(mutation: OnboardingRecordMutation): mutation is StarterPlanMutation {
  return (
    mutation.kind === 'placement' || mutation.kind === 'focus' || mutation.kind === 'week_selection'
  );
}

/**
 * Places a new starter Action on its day, week, and day focus. Once written, these rows belong to
 * the person (planning Plan, Today), so this only ever inserts: it never moves, reorders,
 * re-dates, rewrites, or resurrects a row, and never overfills a day's focus. A permanently deleted
 * id, a day that already has three active focus items, or an insert that conflicts (the id is
 * taken, or a partial unique index already holds the Action for that period) leaves the record out
 * and setup still completes. Returns whether a row was added.
 */
async function addStarterPlanRecord(
  transaction: SqliteTransaction,
  command: OnboardingCommit,
  mutation: StarterPlanMutation,
): Promise<boolean> {
  if (await wasPermanentlyDeleted(transaction, command.ownerId, mutation)) return false;
  if (mutation.kind === 'focus') {
    const day = await transaction.get<{ active: number }>(
      `SELECT COUNT(*) AS active FROM focus_selections
       WHERE owner_id = ? AND profile_id = ? AND local_date = ?
         AND archived_at IS NULL AND deleted_at IS NULL;`,
      [command.ownerId, command.profileId, mutation.localDate],
    );
    if (day === undefined || day.active >= dayFocusLimit) return false;
  }
  // `ON CONFLICT DO NOTHING` without a target also covers the partial unique indexes, which a
  // `(id)` target would still let abort the whole commit.
  const { changes } = await transaction.run(...starterPlanInsert(command, mutation));
  if (changes !== 0 && changes !== 1) throw new DataAdapterError('write_conflict');
  return changes === 1;
}

function starterPlanInsert(
  command: OnboardingCommit,
  mutation: StarterPlanMutation,
): readonly [string, readonly SqliteParameter[]] {
  const stamps = [command.now, command.now, command.now] as const;
  switch (mutation.kind) {
    case 'placement':
      return [
        `INSERT INTO planning_placements (
           id, owner_id, action_id, horizon, period_key, period_start_date, period_end_date,
           sort_key, created_at, updated_at, client_updated_at
         ) VALUES (?, ?, ?, 'day', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING;`,
        [
          mutation.id,
          command.ownerId,
          mutation.actionId,
          mutation.localDate,
          mutation.localDate,
          mutation.localDate,
          mutation.sortKey,
          ...stamps,
        ],
      ];
    case 'focus':
      return [
        `INSERT INTO focus_selections (
           id, owner_id, profile_id, action_id, local_date, sort_key,
           created_at, updated_at, client_updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING;`,
        [
          mutation.id,
          command.ownerId,
          command.profileId,
          mutation.actionId,
          mutation.localDate,
          mutation.sortKey,
          ...stamps,
        ],
      ];
    case 'week_selection':
      return [
        `INSERT INTO week_selections (
           id, owner_id, profile_id, action_id, period_start_date, period_end_date,
           week_start, sort_key, created_at, updated_at, client_updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING;`,
        [
          mutation.id,
          command.ownerId,
          command.profileId,
          mutation.actionId,
          mutation.startDate,
          mutation.endDate,
          mutation.weekStart,
          mutation.sortKey,
          ...stamps,
        ],
      ];
  }
}

/** A permanently deleted identity is never written again, not even by a setup rerun. */
async function assertNeverDeleted(
  transaction: SqliteTransaction,
  ownerId: OwnerId,
  mutation: OnboardingRecordMutation,
): Promise<void> {
  if (await wasPermanentlyDeleted(transaction, ownerId, mutation)) {
    throw new DataAdapterError('write_conflict');
  }
}

async function wasPermanentlyDeleted(
  transaction: SqliteTransaction,
  ownerId: OwnerId,
  mutation: OnboardingRecordMutation,
): Promise<boolean> {
  const deleted = await transaction.get<{ deleted: number }>(
    `SELECT 1 AS deleted FROM deletion_ledger
     WHERE owner_id = ? AND entity_type = ? AND entity_id = ? LIMIT 1;`,
    [ownerId, entityType(mutation.kind), mutation.id],
  );
  return deleted !== undefined;
}

/**
 * Reads, before the commit writes anything, the canonical state of the Profile and of every record
 * the commit may write, through their record codecs, in the order they are written: the Profile,
 * then the records in command order (a record named twice is read once).
 */
async function readBeforeWrites(
  transaction: SqliteTransaction,
  codecs: CanonicalCodecRegistry,
  command: OnboardingCommit,
): Promise<ReplicatedRecord[]> {
  const refs: EntityRef[] = [
    createEntityRef('profile', command.profileId, command.ownerId),
    ...command.records.map(({ kind, id }) =>
      createEntityRef(entityType(kind), id, command.ownerId),
    ),
  ];
  const seen = new Set<EntityRefKey>();
  const records: ReplicatedRecord[] = [];
  for (const [index, ref] of refs.entries()) {
    const operationId = command.outbox.operationIds[index];
    if (operationId === undefined) throw new DataAdapterError('write_conflict');
    const key = entityRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const before = await codecs.resolve(ref.type).read(transaction, ref);
    records.push({ ref, operationId, before });
  }
  return records;
}

/**
 * Queues the outbox group of an account identity's commit through the outbox store of ordinary
 * commands: one operation for each written record whose canonical document changed, in the order
 * read (parent first, so references resolve within the group). A new record is a create; a changed
 * one is an update against the revisions and snapshot read before the writes. The Profile document
 * holds only the planning preferences, so setup progress and the handbook queue nothing for it, and
 * a starter plan record left out (see addStarterPlanRecord) gets no operation. Returns the
 * receipt's sync entry.
 */
async function queueChanges(
  transaction: SqliteTransaction,
  codecs: CanonicalCodecRegistry,
  command: OnboardingCommit,
  replicated: readonly ReplicatedRecord[],
  canonical: readonly AppliedCanonical[],
): Promise<SyncQueueReceipt> {
  const written = new Set(
    canonical.map(({ type, id }) => entityRefKey(createEntityRef(type, id, command.ownerId))),
  );
  const { mutationGroupId } = command.outbox;
  const operations: OutboxOperation[] = [];
  for (const { ref, operationId, before } of replicated) {
    if (!written.has(entityRefKey(ref))) continue;
    const after = await codecs.resolve(ref.type).read(transaction, ref);
    if (after === null) throw new DataAdapterError('write_conflict');
    const mutation = changeFrom(before, after);
    if (mutation === null) continue;
    operations.push({
      operationId,
      mutationGroupId,
      sequence: operations.length,
      state: 'pending',
      attemptCount: 0,
      nextAttemptAt: command.now,
      mutation,
    });
  }
  if (operations.length === 0) return { queued: false };
  const { capabilities, expire } = bindPlanningUnitOfWork(transaction, codecs);
  try {
    await capabilities.outbox.append({
      mutationGroupId,
      ownerId: command.ownerId,
      commandId: command.commandId,
      actor: 'user',
      createdAt: command.now,
      operations,
    });
  } finally {
    expire();
  }
  return {
    queued: true,
    mutationGroupId,
    operationIds: operations.map(({ operationId }) => operationId),
  };
}

/** The canonical mutation from `before` to `after`, or null when the document did not change. */
function changeFrom(
  before: CanonicalRecordState | null,
  after: CanonicalRecordState,
): CanonicalMutation | null {
  if (before === null) {
    return {
      operation: 'create',
      ref: after.ref,
      expectedRevision: null,
      baseServerRevision: 0,
      baseSnapshotHash: null,
      document: after.document,
    };
  }
  if (sameDocument(before.document, after.document)) return null;
  return {
    operation: 'update',
    ref: after.ref,
    expectedRevision: before.localRevision,
    baseServerRevision: before.serverRevision,
    baseSnapshotHash: before.baseSnapshotHash,
    document: after.document,
  };
}

async function appendEventsAndReceipt(
  transaction: SqliteTransaction,
  command: OnboardingCommit,
  written: readonly WrittenRecord[],
  canonical: readonly AppliedCanonical[],
  sync: SyncQueueReceipt,
): Promise<void> {
  const profileEventId = command.eventIds[0];
  if (profileEventId === undefined) throw new DataAdapterError('write_conflict');
  // A starter plan record left out (see addStarterPlanRecord) gets no event, and the receipt lists
  // only the events written.
  const eventTargets = [
    {
      type: 'profile',
      id: command.profileId,
      eventType: command.eventType,
      eventId: profileEventId,
    },
    ...written.map(({ mutation, eventId }) => ({
      type: entityType(mutation.kind),
      id: mutation.id,
      eventType: `onboarding.${mutation.kind}.saved`,
      eventId,
    })),
  ];
  for (const [sequence, target] of eventTargets.entries()) {
    await assertOne(
      transaction.run(
        `INSERT INTO domain_events (
         id, owner_id, command_id, sequence, actor, event_type, entity_type, entity_id,
         payload_schema_version, payload_json, occurred_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'user', ?, ?, ?, 1, ?, ?, ?, ?);`,
        [
          target.eventId,
          command.ownerId,
          command.commandId,
          sequence,
          target.eventType,
          target.type,
          target.id,
          JSON.stringify({ source: 'onboarding' }),
          command.now,
          command.now,
          command.now,
        ],
      ),
    );
  }
  const receipt = {
    commandId: command.commandId,
    ownerId: command.ownerId,
    actor: 'user',
    acceptedAt: command.now,
    canonical: canonical.map(({ type, id, localRevision }) => ({
      ref: { type, id, ownerId: command.ownerId },
      localRevision,
    })),
    eventIds: eventTargets.map(({ eventId }) => eventId),
    undo: { available: false },
    sync,
  };
  await assertOne(
    transaction.run(
      `INSERT INTO command_receipts (
       id, owner_id, command_id, actor, accepted_at, receipt_schema_version,
       receipt_payload_json, created_at, updated_at
     ) VALUES (?, ?, ?, 'user', ?, 1, ?, ?, ?);`,
      [
        command.commandId,
        command.ownerId,
        command.commandId,
        command.now,
        JSON.stringify(receipt),
        command.now,
        command.now,
      ],
    ),
  );
}

async function readAppliedCanonical(
  transaction: SqliteTransaction,
  ownerId: OwnerId,
  mutation: OnboardingRecordMutation,
): Promise<AppliedCanonical> {
  const row = await transaction.get<{ local_revision: number }>(
    `SELECT local_revision FROM ${tableFor(mutation.kind)}
     WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
    [ownerId, mutation.id],
  );
  if (row === undefined || !Number.isSafeInteger(row.local_revision) || row.local_revision < 1) {
    throw new DataAdapterError('write_conflict');
  }
  return { type: entityType(mutation.kind), id: mutation.id, localRevision: row.local_revision };
}

function tableFor(kind: OnboardingRecordMutation['kind']): string {
  switch (kind) {
    case 'axis':
      return 'axes';
    case 'outcome':
      return 'outcomes';
    case 'context':
      return 'contexts';
    case 'constraint':
      return 'constraints';
    case 'commitment':
      return 'commitments';
    case 'time_block':
      return 'time_blocks';
    case 'action':
      return 'actions';
    case 'placement':
      return 'planning_placements';
    case 'focus':
      return 'focus_selections';
    case 'week_selection':
      return 'week_selections';
  }
}

function entityType(kind: OnboardingRecordMutation['kind']): EntityType {
  if (kind === 'placement') return 'planning_placement';
  if (kind === 'focus' || kind === 'week_selection') return 'focus_selection';
  if (kind === 'time_block') return 'time_block';
  return kind;
}

async function loadState(
  connection: SqliteDriver | SqliteTransaction,
): Promise<OnboardingState | null> {
  const rows = await connection.all<ProfileRow>(
    `SELECT ${profileColumns} FROM profiles WHERE deleted_at IS NULL ORDER BY created_at, id LIMIT 2;`,
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new DataAdapterError('identity_ambiguous');
  const row = rows[0];
  if (
    row === undefined ||
    !uuid.safeParse(row.id).success ||
    !uuid.safeParse(row.owner_id).success ||
    !Number.isSafeInteger(row.local_revision) ||
    row.local_revision < 1
  ) {
    throw new DataAdapterError('invalid_persisted_record');
  }
  const completedSteps = parseJson(steps, row.onboarding_completed_steps_json);
  const skippedSteps = parseJson(steps, row.onboarding_skipped_steps_json);
  const persistedArtifacts = parseJson(
    artifactsSchema,
    row.onboarding_artifacts_json,
  ) as unknown as OnboardingArtifacts;
  const starters = await reconcileDeletedStarterArtifacts(
    connection,
    row.owner_id,
    await reconcileDeletedActionArtifacts(connection, row.owner_id, persistedArtifacts),
  );
  const artifacts = starters.artifacts;
  const completedLessons = parseJson(
    z.array(z.number().int().min(0).max(3)),
    row.handbook_completed_lessons_json,
  );
  const baseDraft =
    row.onboarding_draft_json === null
      ? null
      : withoutDeletedStarters(
          parseDraft(row.onboarding_draft_json, row.onboarding_step),
          starters,
        );
  const draft = baseDraft ?? (await reconstructDraft(connection, row, artifacts));
  const today = await loadToday(connection, row, artifacts);
  return {
    ownerId: row.owner_id as OwnerId,
    profileId: row.id as ProfileId,
    profileRevision: row.local_revision,
    status: row.onboarding_status,
    step: row.onboarding_step,
    completedSteps,
    skippedSteps,
    ...(row.defaults_confirmed_at === null
      ? {}
      : { defaultsConfirmedAt: row.defaults_confirmed_at as Instant }),
    ...(row.onboarding_completed_at === null
      ? {}
      : { completedAt: row.onboarding_completed_at as Instant }),
    handbook: { status: row.handbook_status, lesson: row.handbook_lesson, completedLessons },
    draft,
    artifacts,
    today,
  };
}

async function reconstructDraft(
  connection: SqliteDriver | SqliteTransaction,
  profile: ProfileRow,
  artifacts: OnboardingArtifacts,
): Promise<OnboardingDraft> {
  if (
    profile.planning_time_zone === null ||
    profile.week_start === null ||
    profile.time_format === null
  ) {
    throw new DataAdapterError('invalid_persisted_record');
  }
  const axes = await rowsByIds<{ id: string; title: string }>(
    connection,
    'axes',
    ['id', 'title'],
    profile.owner_id,
    artifacts.axisIds,
  );
  const orderedAxes = artifacts.axisIds
    .map((id) => axes.find((axis) => axis.id === id)?.title)
    .filter(isString);
  let outcome: OnboardingDraft['outcome'] = null;
  if (artifacts.outcomeId !== undefined) {
    const row = await connection.get<{
      title: string;
      success_definition: string;
      axis_id: string | null;
      target_end_date: string | null;
    }>(
      `SELECT title, success_definition, axis_id, target_end_date FROM outcomes
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
      [profile.owner_id, artifacts.outcomeId],
    );
    if (row !== undefined) {
      const axisIndex = row.axis_id === null ? -1 : artifacts.axisIds.indexOf(row.axis_id as UUID);
      outcome = {
        title: row.title,
        successDefinition: row.success_definition,
        ...(axisIndex < 0 ? {} : { axisIndex }),
        ...(row.target_end_date === null ? {} : { targetDate: row.target_end_date }),
      };
    }
  }
  const context = await reconstructContext(connection, profile.owner_id, artifacts);
  const commitments = [];
  for (const pair of artifacts.commitments) {
    const row = await connection.get<{
      title: string;
      strength: 'hard' | 'soft';
      starts_at_utc: string;
      ends_at_utc: string;
      time_zone: string;
    }>(
      `SELECT c.title, c.strength, b.starts_at_utc, b.ends_at_utc, b.time_zone
       FROM commitments c JOIN time_blocks b ON b.owner_id = c.owner_id AND b.commitment_id = c.id
       WHERE c.owner_id = ? AND c.id = ? AND b.id = ? AND c.deleted_at IS NULL AND b.deleted_at IS NULL;`,
      [profile.owner_id, pair.commitmentId, pair.timeBlockId],
    );
    if (row !== undefined) {
      const start = zonedParts(row.starts_at_utc, row.time_zone);
      const end = zonedParts(row.ends_at_utc, row.time_zone);
      commitments.push({
        title: row.title,
        strength: row.strength,
        date: start.date,
        start: start.time,
        end: end.time,
        confirmed: true,
        timeZone: row.time_zone,
      });
    }
  }
  const action =
    artifacts.actionId === undefined
      ? undefined
      : await connection.get<{ title: string }>(
          `SELECT title FROM actions WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
          [profile.owner_id, artifacts.actionId],
        );
  const draft: OnboardingDraft = {
    identity: {
      preferredName: profile.preferred_name ?? '',
      locale: profile.locale_override ?? '',
    },
    defaults: {
      planningTimeZone: profile.planning_time_zone,
      weekStart: profile.week_start as NonNullable<OnboardingDraft['defaults']>['weekStart'],
      timeFormat: profile.time_format,
      locale: profile.locale_override ?? 'en',
    },
    context,
    axes: orderedAxes,
    outcome,
    week: { commitments, actionTitle: action?.title ?? '' },
  };
  const validated =
    action === undefined
      ? validateOnboardingStep('outcome', draft)
      : validateOnboardingDraft(draft);
  // The rows may have been edited since setup through commands with their own limits (for
  // example a longer success definition, or two Axes renamed alike in alignment). That is not
  // corruption: keep the plan loadable and let a rerun show the values to adjust before saving.
  return validated.ok ? validated.value : draft;
}

async function reconcileDeletedActionArtifacts(
  connection: SqliteDriver | SqliteTransaction,
  ownerId: string,
  artifacts: OnboardingArtifacts,
): Promise<OnboardingArtifacts> {
  if (artifacts.actionId === undefined) return artifacts;
  const action = await connection.get<{ id: string }>(
    `SELECT id FROM actions WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
    [ownerId, artifacts.actionId],
  );
  if (action !== undefined) return artifacts;
  const remaining = { ...artifacts };
  Reflect.deleteProperty(remaining, 'actionId');
  Reflect.deleteProperty(remaining, 'placementId');
  Reflect.deleteProperty(remaining, 'focusId');
  Reflect.deleteProperty(remaining, 'weekSelectionId');
  return remaining;
}

type StarterReconciliation = Readonly<{
  artifacts: OnboardingArtifacts;
  /** Indexes, in the persisted artifact order, of starter Axes that were permanently deleted. */
  removedAxisIndexes: readonly number[];
  outcomeRemoved: boolean;
}>;

type MutableOnboardingArtifacts = {
  -readonly [Key in keyof OnboardingArtifacts]: OnboardingArtifacts[Key];
};

/**
 * Drops permanently deleted starter Axes and the starter Outcome (deletion ledger) from the
 * artifacts, so a rerun neither refuses to continue nor recreates them.
 */
async function reconcileDeletedStarterArtifacts(
  connection: SqliteDriver | SqliteTransaction,
  ownerId: string,
  artifacts: OnboardingArtifacts,
): Promise<StarterReconciliation> {
  const deleted = async (type: EntityType, ids: readonly UUID[]): Promise<Set<string>> => {
    if (ids.length === 0) return new Set();
    const rows = await connection.all<{ entity_id: string }>(
      `SELECT entity_id FROM deletion_ledger
       WHERE owner_id = ? AND entity_type = ? AND entity_id IN (${ids.map(() => '?').join(',')});`,
      [ownerId, type, ...ids],
    );
    return new Set(rows.map((row) => row.entity_id));
  };
  const deletedAxes = await deleted('axis', artifacts.axisIds);
  const outcomeRemoved =
    artifacts.outcomeId !== undefined && (await deleted('outcome', [artifacts.outcomeId])).size > 0;
  if (deletedAxes.size === 0 && !outcomeRemoved) {
    return { artifacts, removedAxisIndexes: [], outcomeRemoved: false };
  }
  const remaining: MutableOnboardingArtifacts = {
    ...artifacts,
    axisIds: artifacts.axisIds.filter((id) => !deletedAxes.has(id)),
  };
  if (outcomeRemoved) Reflect.deleteProperty(remaining, 'outcomeId');
  return {
    artifacts: remaining,
    removedAxisIndexes: artifacts.axisIds.flatMap((id, index) =>
      deletedAxes.has(id) ? [index] : [],
    ),
    outcomeRemoved,
  };
}

/**
 * A draft saved before a starter Axis or the starter Outcome was permanently deleted still names
 * them by position. Remove them so the draft stays aligned with the remaining artifacts and a
 * rerun cannot recreate them under a new id.
 */
function withoutDeletedStarters(
  draft: OnboardingDraft,
  reconciliation: StarterReconciliation,
): OnboardingDraft {
  const removed = new Set(reconciliation.removedAxisIndexes);
  if (removed.size === 0 && !reconciliation.outcomeRemoved) return draft;
  const shift = (index: number) =>
    index - reconciliation.removedAxisIndexes.filter((removedIndex) => removedIndex < index).length;
  let outcome = reconciliation.outcomeRemoved ? null : draft.outcome;
  if (outcome?.axisIndex !== undefined) {
    const { axisIndex, ...unlinked } = outcome;
    outcome = removed.has(axisIndex) ? unlinked : { ...outcome, axisIndex: shift(axisIndex) };
  }
  return {
    ...draft,
    axes: draft.axes.filter((_, index) => !removed.has(index)),
    outcome,
  };
}

async function reconstructContext(
  connection: SqliteDriver | SqliteTransaction,
  ownerId: string,
  artifacts: OnboardingArtifacts,
): Promise<OnboardingDraft['context']> {
  const context: {
    awakeWindow?: { start: string; end: string };
    availability?: {
      label: string;
      weekdays: Weekday[];
      start: string;
      end: string;
      strength: 'hard' | 'soft' | 'unknown';
    };
    boundary?: { text: string; strength: 'hard' | 'soft' | 'unknown' };
  } = {};
  if (artifacts.awakeContextId !== undefined) {
    const row = await connection.get<{ value_text: string }>(
      `SELECT value_text FROM contexts WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
      [ownerId, artifacts.awakeContextId],
    );
    const [start, end] = row?.value_text.split('/') ?? [];
    if (start !== undefined && end !== undefined) context.awakeWindow = { start, end };
  }
  if (
    artifacts.availabilityContextId !== undefined &&
    artifacts.availabilityConstraintId !== undefined
  ) {
    const row = await connection.get<{
      value_text: string;
      strength: 'hard' | 'soft' | 'unknown';
      value_payload_json: string;
    }>(
      `SELECT c.value_text, c.strength, x.value_payload_json FROM contexts c
       JOIN constraints x ON x.owner_id = c.owner_id AND x.context_id = c.id
       WHERE c.owner_id = ? AND c.id = ? AND x.id = ? AND c.deleted_at IS NULL AND x.deleted_at IS NULL;`,
      [ownerId, artifacts.availabilityContextId, artifacts.availabilityConstraintId],
    );
    if (row !== undefined) {
      const payload = z
        .strictObject({
          kind: z.literal('availability'),
          windows: z
            .array(
              z.strictObject({
                weekday: z.enum([
                  'monday',
                  'tuesday',
                  'wednesday',
                  'thursday',
                  'friday',
                  'saturday',
                  'sunday',
                ]),
                start: z.string(),
                end: z.string(),
              }),
            )
            .min(1),
        })
        .parse(JSON.parse(row.value_payload_json));
      const first = payload.windows[0];
      if (first !== undefined)
        context.availability = {
          label: row.value_text,
          weekdays: payload.windows.map(({ weekday }) => weekday),
          start: first.start,
          end: first.end,
          strength: row.strength,
        };
    }
  }
  if (artifacts.boundaryContextId !== undefined) {
    const row = await connection.get<{ value_text: string; strength: 'hard' | 'soft' | 'unknown' }>(
      `SELECT value_text, strength FROM contexts WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
      [ownerId, artifacts.boundaryContextId],
    );
    if (row !== undefined) context.boundary = { text: row.value_text, strength: row.strength };
  }
  return context;
}

async function loadToday(
  connection: SqliteDriver | SqliteTransaction,
  profile: ProfileRow,
  artifacts: OnboardingArtifacts,
): Promise<OnboardingState['today']> {
  const axes = await rowsByIds<{ id: string; title: string; state: string }>(
    connection,
    'axes',
    ['id', 'title', 'state'],
    profile.owner_id,
    artifacts.axisIds,
  );
  const orderedAxes = artifacts.axisIds
    .map((id) => axes.find((axis) => axis.id === id && axis.state !== 'archived'))
    .filter(isDefined)
    .map(({ id, title }) => ({ id, title }));
  const placement =
    artifacts.placementId === undefined
      ? undefined
      : await connection.get<{ period_start_date: string }>(
          `SELECT period_start_date FROM planning_placements WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
          [profile.owner_id, artifacts.placementId],
        );
  const selection =
    artifacts.weekSelectionId === undefined
      ? undefined
      : await connection.get<{ period_start_date: string; period_end_date: string }>(
          `SELECT period_start_date, period_end_date FROM week_selections WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
          [profile.owner_id, artifacts.weekSelectionId],
        );
  const action =
    artifacts.actionId === undefined
      ? undefined
      : await connection.get<{ id: string; title: string }>(
          `SELECT id, title FROM actions WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
          [profile.owner_id, artifacts.actionId],
        );
  let outcome: OnboardingState['today']['outcome'];
  if (artifacts.outcomeId !== undefined) {
    const row = await connection.get<{
      id: string;
      title: string;
      success_definition: string;
      axis_id: string | null;
    }>(
      `SELECT id, title, success_definition, axis_id FROM outcomes
       WHERE owner_id = ? AND id = ? AND state <> 'archived' AND deleted_at IS NULL;`,
      [profile.owner_id, artifacts.outcomeId],
    );
    if (row !== undefined) {
      const axisTitle =
        row.axis_id === null
          ? undefined
          : orderedAxes.find((axis) => axis.id === row.axis_id)?.title;
      outcome = {
        id: row.id,
        title: row.title,
        successDefinition: row.success_definition,
        ...(axisTitle === undefined ? {} : { axisTitle }),
      };
    }
  }
  const commitments = [];
  for (const pair of artifacts.commitments) {
    const row = await connection.get<{
      id: string;
      title: string;
      strength: 'hard' | 'soft';
      starts_at_utc: string;
      ends_at_utc: string;
      time_zone: string;
    }>(
      `SELECT c.id, c.title, c.strength, b.starts_at_utc, b.ends_at_utc, b.time_zone
       FROM commitments c JOIN time_blocks b ON b.owner_id = c.owner_id AND b.commitment_id = c.id
       WHERE c.owner_id = ? AND c.id = ? AND b.id = ? AND c.deleted_at IS NULL AND b.deleted_at IS NULL;`,
      [profile.owner_id, pair.commitmentId, pair.timeBlockId],
    );
    if (row !== undefined)
      commitments.push({
        id: row.id,
        title: row.title,
        strength: row.strength,
        startsAtUtc: row.starts_at_utc,
        endsAtUtc: row.ends_at_utc,
        timeZone: row.time_zone,
      });
  }
  return {
    date: placement?.period_start_date ?? '',
    weekStartDate: selection?.period_start_date ?? '',
    weekEndDate: selection?.period_end_date ?? '',
    ...(profile.preferred_name === null ? {} : { preferredName: profile.preferred_name }),
    axes: orderedAxes,
    ...(outcome === undefined ? {} : { outcome }),
    ...(action === undefined ? {} : { action }),
    commitments,
  };
}

async function rowsByIds<Row extends object & { id: string }>(
  connection: SqliteDriver | SqliteTransaction,
  table: 'axes',
  columns: readonly string[],
  ownerId: string,
  ids: readonly UUID[],
): Promise<Row[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return connection.all<Row>(
    `SELECT ${columns.join(', ')} FROM ${table} WHERE owner_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL;`,
    [ownerId, ...ids],
  );
}

function parseDraft(value: string, currentStep: OnboardingStep): OnboardingDraft {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    throw new DataAdapterError('invalid_persisted_record');
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new DataAdapterError('invalid_persisted_record');
  }
  const validationStep: OnboardingStep = (
    {
      welcome: 'welcome',
      defaults: 'welcome',
      context: 'defaults',
      axes: 'context',
      outcome: 'axes',
      week: 'outcome',
      handbook: 'week',
    } as const
  )[currentStep];
  let checked;
  try {
    checked = validateOnboardingStep(validationStep, candidate as OnboardingDraft);
  } catch {
    throw new DataAdapterError('invalid_persisted_record');
  }
  if (!checked.ok) throw new DataAdapterError('invalid_persisted_record');
  return checked.value;
}

function parseJson<Output>(schema: z.ZodType<Output>, value: string): Output {
  try {
    return schema.parse(JSON.parse(value));
  } catch {
    throw new DataAdapterError('invalid_persisted_record');
  }
}

function zonedParts(instant: string, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

async function assertOne(result: Promise<{ changes: number }>): Promise<void> {
  if ((await result).changes !== 1) throw new DataAdapterError('write_conflict');
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}
function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
