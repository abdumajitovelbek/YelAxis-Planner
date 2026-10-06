import type {
  AccountTransaction,
  BundleConflictCandidate,
  BundleSupplement,
  CanonicalSnapshotRecord,
  EncodedBundle,
  ImportDestination,
  ImportJournal,
  ImportRecoveryBackup,
  ImportStorePort,
  ImportTransaction,
  PlanningUnitOfWork,
  SyncQueueReceipt,
} from '@yelaxis/application';
import type { EntityType, Instant, OwnerId, UUID } from '@yelaxis/domain';
import { z } from 'zod';

import { bindAccountTransaction } from '../account/sqlite-account-store';
import {
  createDefaultCanonicalCodecRegistry,
  type CanonicalCodecRegistry,
} from '../application/canonical-codecs';
import { DataAdapterError } from '../application/errors';
import { bindPlanningUnitOfWork } from '../application/sqlite-adapters';
import type { SqliteDriver, SqliteQueryConnection } from '../sqlite/driver';
import { syncEntityTables } from '../sync/sync-tables';

const journalSchema = z.strictObject({
  id: z.uuid(),
  owner_id: z.uuid(),
  bundle_json: z.string(),
  mode: z.enum(['merge', 'replace']),
  decisions_json: z.string(),
  remap_json: z.string(),
  destination_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  created_at: z.iso.datetime(),
});

const decisionsSchema = z.array(
  z.strictObject({
    type: z.enum(Object.keys(syncEntityTables) as EntityType[]),
    id: z.uuid().transform((value) => value as UUID),
    decision: z.enum(['keep_current', 'use_imported', 'duplicate_imported']),
  }),
);
const duplicatedIdsSchema = z.record(
  z.string(),
  z.uuid().transform((value) => value as UUID),
);

/** The same owner-bound validation serves startup reads and ordinary import transactions. */
async function readJournalValue(
  connection: Pick<SqliteQueryConnection, 'get'>,
  ownerId: OwnerId,
): Promise<ImportJournal | null> {
  const candidate = await connection.get<object>(
    'SELECT id, owner_id, bundle_json, mode, decisions_json, remap_json, destination_digest, created_at FROM import_journal WHERE owner_id = ?;',
    [ownerId],
  );
  if (candidate === undefined) return null;
  const parsed = journalSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.owner_id !== ownerId)
    throw new DataAdapterError('invalid_persisted_record');
  const row = parsed.data;
  try {
    const decisions = decisionsSchema.safeParse(JSON.parse(row.decisions_json));
    const duplicatedIds = duplicatedIdsSchema.safeParse(JSON.parse(row.remap_json));
    if (!decisions.success || !duplicatedIds.success)
      throw new DataAdapterError('invalid_persisted_record');
    return {
      id: row.id as UUID,
      ownerId,
      text: row.bundle_json,
      mode: row.mode,
      decisions: decisions.data,
      duplicatedIds: duplicatedIds.data,
      destinationDigest: row.destination_digest,
      createdAt: row.created_at as Instant,
    };
  } catch {
    // Malformed JSON and schema diagnostics must not expose planning payloads across this boundary.
    throw new DataAdapterError('invalid_persisted_record');
  }
}

class SqliteImportTransaction implements ImportTransaction {
  readonly records: PlanningUnitOfWork['records'];
  readonly events: PlanningUnitOfWork['events'];
  readonly undo: PlanningUnitOfWork['undo'];
  readonly outbox: PlanningUnitOfWork['outbox'];
  readonly receipts: PlanningUnitOfWork['receipts'];

  constructor(
    private readonly connection: SqliteQueryConnection,
    private readonly account: AccountTransaction,
    planning: PlanningUnitOfWork,
    private readonly ownerId: OwnerId,
    private readonly assertActive: () => void,
  ) {
    this.records = {
      read: planning.records.read.bind(planning.records),
      apply: async (mutation, context) => {
        const change = await planning.records.apply(mutation, context);
        if (mutation.ref.type === 'reminder' && mutation.operation === 'create') {
          // A restored definition starts a new local lifecycle even when its stable id and
          // initial local revision match an older, already-dispatched definition.
          await this.connection.run(
            'DELETE FROM notification_receipts WHERE owner_id = ? AND reminder_id = ?;',
            [this.ownerId, mutation.ref.id],
          );
          await this.connection.run(
            'DELETE FROM notification_routine_cursors WHERE owner_id = ? AND reminder_id = ?;',
            [this.ownerId, mutation.ref.id],
          );
        }
        return change;
      },
    };
    this.events = planning.events;
    this.undo = planning.undo;
    this.outbox = planning.outbox;
    this.receipts = planning.receipts;
  }

  async destination(): Promise<ImportDestination> {
    this.assertActive();
    const identity = await this.account.identities.find(this.ownerId);
    if (identity === null) throw new DataAdapterError('invalid_identity_record');
    const snapshot = await this.account.records.snapshot(this.ownerId);
    const supplement = await this.account.records.supplement(this.ownerId);
    const facts = await this.account.sync.facts(this.ownerId);
    const unconfirmed = await this.connection.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sync_outbox WHERE owner_id = ? AND deleted_at IS NULL AND state IN ('pending', 'sending', 'retry_wait') AND (state = 'sending' OR attempt_count > 0);",
      [this.ownerId],
    );
    return {
      snapshot,
      supplement,
      accountLinked: identity.kind === 'account',
      syncWasPending: facts.pendingOperations > 0,
      unconfirmedSync: (unconfirmed?.count ?? 0) > 0,
    };
  }

  async journal(): Promise<ImportJournal | null> {
    this.assertActive();
    return await readJournalValue(this.connection, this.ownerId);
  }

  async saveJournal(journal: ImportJournal): Promise<void> {
    this.assertActive();
    if (journal.ownerId !== this.ownerId) throw new DataAdapterError('write_conflict');
    await this.connection.run(
      'INSERT INTO import_journal (id, owner_id, bundle_json, mode, decisions_json, remap_json, destination_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET id = excluded.id, bundle_json = excluded.bundle_json, mode = excluded.mode, decisions_json = excluded.decisions_json, remap_json = excluded.remap_json, destination_digest = excluded.destination_digest, created_at = excluded.created_at, updated_at = excluded.updated_at;',
      [
        journal.id,
        this.ownerId,
        journal.text,
        journal.mode,
        JSON.stringify(journal.decisions),
        JSON.stringify(journal.duplicatedIds),
        journal.destinationDigest,
        journal.createdAt,
        journal.createdAt,
      ],
    );
  }

  async discardJournal(): Promise<void> {
    this.assertActive();
    await this.connection.run('DELETE FROM import_journal WHERE owner_id = ?;', [this.ownerId]);
  }

  async saveBackup(bundle: EncodedBundle, at: Instant): Promise<void> {
    this.assertActive();
    await this.connection.run(
      'INSERT INTO import_recovery_backups (id, owner_id, bundle_json, data_sha256, record_count, verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
      [
        bundle.bundleId,
        this.ownerId,
        bundle.text,
        bundle.manifest.dataSha256,
        bundle.recordCount,
        at,
        at,
        at,
      ],
    );
  }

  async backup(): Promise<ImportRecoveryBackup | null> {
    this.assertActive();
    const row = await this.connection.get<{
      id: UUID;
      bundle_json: string;
      record_count: number;
      created_at: Instant;
    }>(
      'SELECT id, bundle_json, record_count, created_at FROM import_recovery_backups WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1;',
      [this.ownerId],
    );
    return row === undefined
      ? null
      : {
          backupId: row.id,
          text: row.bundle_json,
          recordCount: row.record_count,
          createdAt: row.created_at,
        };
  }

  async prepareReplacementDeletes(
    refs: readonly { readonly type: EntityType; readonly id: UUID }[],
  ): Promise<void> {
    this.assertActive();
    for (const ref of refs) {
      const blocked = await this.connection.get<{ found: number }>(
        "SELECT 1 AS found FROM sync_outbox WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL AND (state = 'sending' OR attempt_count > 0) AND state <> 'acknowledged' UNION ALL SELECT 1 FROM sync_conflicts WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL AND state = 'open' LIMIT 1;",
        [this.ownerId, ref.type, ref.id, this.ownerId, ref.type, ref.id],
      );
      if (blocked !== undefined) throw new DataAdapterError('write_conflict');
      await this.connection.run(
        "DELETE FROM sync_outbox WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND state <> 'acknowledged' AND attempt_count = 0;",
        [this.ownerId, ref.type, ref.id],
      );
    }
  }

  async clearDeletion(type: EntityType, id: UUID): Promise<number> {
    this.assertActive();
    const row = await this.connection.get<{ server_revision: number }>(
      'SELECT server_revision FROM deletion_ledger WHERE owner_id = ? AND entity_type = ? AND entity_id = ?;',
      [this.ownerId, type, id],
    );
    await this.connection.run(
      'DELETE FROM deletion_ledger WHERE owner_id = ? AND entity_type = ? AND entity_id = ?;',
      [this.ownerId, type, id],
    );
    return row?.server_revision ?? 0;
  }

  async setRestoredBase(type: EntityType, id: UUID, serverRevision: number): Promise<void> {
    this.assertActive();
    for (const source of syncEntityTables[type])
      await this.connection.run(
        `UPDATE ${source.table} SET server_revision = ?, base_snapshot_hash = NULL WHERE owner_id = ? AND id = ?;`,
        [serverRevision, this.ownerId, id],
      );
  }

  async createProfile(
    record: CanonicalSnapshotRecord,
    supplement: BundleSupplement,
    at: Instant,
  ): Promise<void> {
    this.assertActive();
    const settings = supplement.profileSettings;
    await this.account.profiles.seed({
      ownerId: this.ownerId,
      profileId: record.id,
      at,
      seed: {
        planningTimeZone: record.document['planningTimeZone'] as string,
        weekStart: record.document['weekStart'] as string,
        timeFormat: record.document['timeFormat'] as '12_hour' | '24_hour',
        preferredName: settings?.preferredName ?? null,
        localeOverride: settings?.localeOverride ?? null,
        defaultsConfirmedAt: settings?.deviceState?.defaultsConfirmedAt ?? null,
        onboarding: settings?.deviceState?.onboarding ?? {
          status: 'completed',
          step: 'handbook',
          completedSteps: [],
          skippedSteps: [],
          completedAt: at,
        },
        handbook: settings?.deviceState?.handbook ?? {
          status: 'skipped',
          lesson: 0,
          completedLessons: [],
        },
      },
    });
  }

  async applySupplement(
    supplement: BundleSupplement,
    mode: 'merge' | 'replace',
    remap: Readonly<Record<string, UUID>>,
    at: Instant,
  ): Promise<void> {
    this.assertActive();
    if (mode === 'replace') {
      await this.connection.run('DELETE FROM notification_receipts WHERE owner_id = ?;', [
        this.ownerId,
      ]);
      await this.connection.run('DELETE FROM notification_routine_cursors WHERE owner_id = ?;', [
        this.ownerId,
      ]);
    }
    const settings = supplement.profileSettings;
    if (settings !== null) {
      const profileId = remap[`profile:${settings.profileId}`] ?? settings.profileId;
      await this.connection.run(
        'UPDATE profiles SET preferred_name = ?, locale_override = ?, updated_at = ? WHERE owner_id = ? AND id = ?;',
        [settings.preferredName, settings.localeOverride, at, this.ownerId, profileId],
      );
      if (settings.deviceState !== undefined) {
        const state = settings.deviceState;
        await this.connection.run(
          'UPDATE profiles SET defaults_confirmed_at = ?, onboarding_status = ?, onboarding_step = ?, onboarding_completed_steps_json = ?, onboarding_skipped_steps_json = ?, onboarding_completed_at = ?, handbook_status = ?, handbook_lesson = ?, handbook_completed_lessons_json = ? WHERE owner_id = ? AND id = ?;',
          [
            state.defaultsConfirmedAt,
            state.onboarding.status,
            state.onboarding.step,
            JSON.stringify(state.onboarding.completedSteps),
            JSON.stringify(state.onboarding.skippedSteps),
            state.onboarding.completedAt,
            state.handbook.status,
            state.handbook.lesson,
            JSON.stringify(state.handbook.completedLessons),
            this.ownerId,
            profileId,
          ],
        );
      }
      if (settings.onboardingDraft !== undefined)
        await this.connection.run(
          'UPDATE profiles SET onboarding_draft_json = ? WHERE owner_id = ? AND id = ?;',
          [
            settings.onboardingDraft === null ? null : JSON.stringify(settings.onboardingDraft),
            this.ownerId,
            profileId,
          ],
        );
      if (settings.onboardingArtifacts !== undefined)
        await this.connection.run(
          'UPDATE profiles SET onboarding_artifacts_json = ? WHERE owner_id = ? AND id = ?;',
          [
            JSON.stringify(remapProfileArtifacts(settings.onboardingArtifacts, remap)),
            this.ownerId,
            profileId,
          ],
        );
    }
    for (const deletion of supplement.tombstones ?? []) {
      const id = remap[`${deletion.entityType}:${deletion.entityId}`] ?? deletion.entityId;
      const live = await this.records.read({
        type: deletion.entityType,
        id,
        ownerId: this.ownerId,
      });
      if (live !== null) throw new DataAdapterError('write_conflict');
      await this.connection.run(
        'INSERT INTO deletion_ledger (id, owner_id, entity_type, entity_id, local_revision, server_revision, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT(owner_id, entity_type, entity_id) DO NOTHING;',
        [
          `${this.ownerId}:${deletion.entityType}:${id}`,
          this.ownerId,
          deletion.entityType,
          id,
          deletion.localRevision,
          deletion.deletedAt,
          deletion.deletedAt,
          at,
        ],
      );
    }
    for (const event of supplement.history ?? []) {
      const entityId = remap[`${event.entityType}:${event.entityId}`] ?? event.entityId;
      await this.connection.run(
        "INSERT INTO domain_events (id, owner_id, command_id, sequence, actor, event_type, entity_type, entity_id, payload_schema_version, payload_json, occurred_at, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1, '{}', ?, ?, ?) ON CONFLICT(id) DO NOTHING;",
        [
          event.eventId,
          this.ownerId,
          event.eventId,
          event.actor,
          event.eventType,
          event.entityType,
          entityId,
          event.occurredAt,
          event.occurredAt,
          at,
        ],
      );
    }
    for (const conflict of supplement.openConflicts) {
      const id = remap[`${conflict.entityType}:${conflict.entityId}`] ?? conflict.entityId;
      const conflictId = remap[`recovery_conflict:${conflict.conflictId}`] ?? conflict.conflictId;
      const groups = await this.connection.all<{ mutation_group_id: UUID }>(
        'SELECT DISTINCT mutation_group_id FROM sync_outbox WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL AND state <> ?;',
        [this.ownerId, conflict.entityType, id, 'acknowledged'],
      );
      for (const group of groups)
        await this.connection.run(
          "UPDATE sync_outbox SET state = 'blocked_conflict', updated_at = ? WHERE owner_id = ? AND mutation_group_id = ? AND state IN ('pending', 'retry_wait');",
          [at, this.ownerId, group.mutation_group_id],
        );
      const payload = {
        v: 1,
        origin: 'this_device',
        base: remapDocument(conflict.base, remap),
        local: {
          deleted: conflict.local.deleted,
          document: remapDocument(conflict.local.document, remap),
        },
        remote: {
          deleted: conflict.remote.deleted,
          document: remapDocument(conflict.remote.document, remap),
        },
        fields: conflict.fields,
        blockedGroups: groups.map((group) => group.mutation_group_id),
        serverConflictIds: [],
        closure: 'none',
      };
      await this.connection.run(
        "INSERT INTO sync_conflicts (id, owner_id, entity_type, entity_id, conflict_kind, state, candidate_schema_version, candidate_payload_json, base_server_revision, remote_server_revision, resolution_strategy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', 1, ?, 0, 0, 'import_recovery', ?, ?) ON CONFLICT(id) DO NOTHING;",
        [
          conflictId,
          this.ownerId,
          conflict.entityType,
          id,
          conflict.kind,
          JSON.stringify(payload),
          conflict.createdAt,
          at,
        ],
      );
    }
  }

  async recoveryConflicts(): Promise<readonly BundleConflictCandidate[]> {
    this.assertActive();
    const ids = await this.connection.all<{ id: UUID }>(
      "SELECT id FROM sync_conflicts WHERE owner_id = ? AND state = 'open' AND resolution_strategy = 'import_recovery' AND deleted_at IS NULL ORDER BY created_at, id;",
      [this.ownerId],
    );
    const selected = new Set(ids.map((row) => row.id));
    return (await this.account.records.supplement(this.ownerId)).openConflicts.filter((conflict) =>
      selected.has(conflict.conflictId),
    );
  }

  async closeRecoveryConflict(conflictId: UUID, at: Instant): Promise<void> {
    this.assertActive();
    const row = await this.connection.get<{
      entity_type: EntityType;
      entity_id: UUID;
      candidate_payload_json: string;
    }>(
      "SELECT entity_type, entity_id, candidate_payload_json FROM sync_conflicts WHERE owner_id = ? AND id = ? AND state = 'open' AND resolution_strategy = 'import_recovery';",
      [this.ownerId, conflictId],
    );
    if (row === undefined) throw new DataAdapterError('write_conflict');
    const payload = JSON.parse(row.candidate_payload_json) as { blockedGroups: readonly UUID[] };
    await this.connection.run(
      "UPDATE sync_conflicts SET state = 'resolved', resolution_strategy = 'recovery_resolved', resolved_at = ?, candidate_payload_json = ?, updated_at = ?, local_revision = local_revision + 1 WHERE owner_id = ? AND id = ?;",
      [
        at,
        JSON.stringify({
          v: 1,
          origin: 'this_device',
          base: null,
          local: { deleted: false, document: null },
          remote: { deleted: false, document: null },
          fields: [],
          blockedGroups: [],
          serverConflictIds: [],
          closure: 'done',
        }),
        at,
        this.ownerId,
        conflictId,
      ],
    );
    for (const groupId of payload.blockedGroups) {
      const stillBlocked = await this.connection.get<{ found: number }>(
        "SELECT 1 AS found FROM sync_conflicts WHERE owner_id = ? AND state = 'open' AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM json_each(sync_conflicts.candidate_payload_json, '$.blockedGroups') WHERE value = ?) LIMIT 1;",
        [this.ownerId, groupId],
      );
      if (stillBlocked === undefined)
        await this.connection.run(
          "UPDATE sync_outbox SET state = 'pending', updated_at = ? WHERE owner_id = ? AND mutation_group_id = ? AND state = 'blocked_conflict';",
          [at, this.ownerId, groupId],
        );
    }
  }

  async rewriteRecoveryOperations(
    type: EntityType,
    id: UUID,
    document: Readonly<Record<string, unknown>>,
    at: Instant,
  ): Promise<SyncQueueReceipt> {
    this.assertActive();
    const operations = await this.connection.all<{ operation_id: UUID; mutation_group_id: UUID }>(
      "SELECT operation_id, mutation_group_id FROM sync_outbox WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL AND state <> 'acknowledged' AND operation_kind IN ('create', 'update') AND attempt_count = 0 ORDER BY rowid;",
      [this.ownerId, type, id],
    );
    const first = operations[0];
    if (first === undefined) return { queued: false };
    await this.connection.run(
      "UPDATE sync_outbox SET document_payload_json = ?, updated_at = ? WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL AND state <> 'acknowledged' AND operation_kind IN ('create', 'update') AND attempt_count = 0;",
      [JSON.stringify(document), at, this.ownerId, type, id],
    );
    await this.connection.run(
      "DELETE FROM sync_outbox WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL AND state <> 'acknowledged' AND operation_kind = 'delete' AND attempt_count = 0;",
      [this.ownerId, type, id],
    );
    return {
      queued: true,
      mutationGroupId: first.mutation_group_id,
      operationIds: operations
        .filter((row) => row.mutation_group_id === first.mutation_group_id)
        .map((row) => row.operation_id),
    };
  }

  async validateCommittedGraph(): Promise<void> {
    this.assertActive();
    const violations = await this.connection.all('PRAGMA foreign_key_check;');
    if (violations.length > 0) throw new DataAdapterError('write_conflict');
  }
}

function remapDocument(
  value: Record<string, unknown> | Readonly<Record<string, unknown>> | null,
  remap: Readonly<Record<string, UUID>>,
): unknown {
  if (value === null) return null;
  // Only record-shaped candidates were accepted by the decoder. The stable UUID map includes
  // typed keys; their values are rewritten only in ID-bearing fields, never in user prose.
  const fieldTypes: Record<string, string> = {
    axisId: 'axis',
    outcomeId: 'outcome',
    primaryOutcomeId: 'outcome',
    milestoneId: 'milestone',
    projectId: 'project',
    actionId: 'action',
    commitmentId: 'commitment',
    routineId: 'routine',
    routineOccurrenceId: 'routine_occurrence',
    reviewId: 'review',
    timeBlockId: 'time_block',
    supersededById: 'time_block',
    contextId: 'context',
    profileId: 'profile',
  };
  const visit = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (candidate === null || typeof candidate !== 'object') return candidate;
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>).map(([field, child]) => {
        if (
          field === 'convertedTo' &&
          child !== null &&
          typeof child === 'object' &&
          !Array.isArray(child) &&
          'type' in child &&
          'id' in child &&
          (child.type === 'note' || child.type === 'project') &&
          typeof child.id === 'string'
        )
          return [field, { ...child, id: remap[`${child.type}:${child.id}`] ?? child.id }];
        return [
          field,
          typeof child === 'string' && fieldTypes[field] !== undefined
            ? (remap[`${fieldTypes[field]}:${child}`] ?? child)
            : visit(child),
        ];
      }),
    );
  };
  return visit(value);
}

function remapProfileArtifacts(
  artifacts: NonNullable<BundleSupplement['profileSettings']>['onboardingArtifacts'],
  remap: Readonly<Record<string, UUID>>,
): unknown {
  if (artifacts === undefined) return undefined;
  const types: Record<string, EntityType> = {
    outcomeId: 'outcome',
    actionId: 'action',
    placementId: 'planning_placement',
    focusId: 'focus_selection',
    weekSelectionId: 'focus_selection',
    awakeContextId: 'context',
    availabilityContextId: 'context',
    availabilityConstraintId: 'constraint',
    boundaryContextId: 'context',
  };
  return Object.fromEntries(
    Object.entries(artifacts).map(([field, value]) => {
      if (field === 'axisIds')
        return [field, artifacts.axisIds.map((id) => remap[`axis:${id}`] ?? id)];
      if (field === 'commitments')
        return [
          field,
          artifacts.commitments.map((row) => ({
            commitmentId: remap[`commitment:${row.commitmentId}`] ?? row.commitmentId,
            timeBlockId: remap[`time_block:${row.timeBlockId}`] ?? row.timeBlockId,
          })),
        ];
      const type = types[field];
      return [
        field,
        type === undefined || typeof value !== 'string'
          ? value
          : (remap[`${type}:${value}`] ?? value),
      ];
    }),
  );
}

export class SqliteImportStore implements ImportStorePort {
  readonly #codecs: CanonicalCodecRegistry;
  constructor(
    private readonly driver: SqliteDriver,
    options: { readonly codecs?: CanonicalCodecRegistry; readonly ownerId?: OwnerId } = {},
  ) {
    this.#codecs = options.codecs ?? createDefaultCanonicalCodecRegistry();
    this.#ownerId = options.ownerId;
  }
  readonly #ownerId: OwnerId | undefined;

  async #activeOwner(account: AccountTransaction): Promise<OwnerId> {
    const identities = await account.identities.listActive();
    const identity =
      this.#ownerId === undefined
        ? identities.length === 1
          ? identities[0]
          : undefined
        : identities.find((row) => row.id === this.#ownerId);
    if (identity === undefined) throw new DataAdapterError('identity_ambiguous');
    return identity.id;
  }

  async readJournal(): Promise<ImportJournal | null> {
    const account = bindAccountTransaction(this.driver, this.#codecs);
    try {
      const ownerId = await this.#activeOwner(account.transaction);
      return await readJournalValue(this.driver, ownerId);
    } finally {
      account.expire();
    }
  }

  runInTransaction<T>(work: (transaction: ImportTransaction) => Promise<T>): Promise<T> {
    return this.driver.transaction(async (connection) => {
      await connection.run('PRAGMA defer_foreign_keys = ON;');
      const account = bindAccountTransaction(connection, this.#codecs);
      const planning = bindPlanningUnitOfWork(connection, this.#codecs);
      let active = true;
      try {
        const ownerId = await this.#activeOwner(account.transaction);
        const assertActive = () => {
          if (!active) throw new DataAdapterError('capability_expired');
        };
        return await work(
          new SqliteImportTransaction(
            connection,
            account.transaction,
            planning.capabilities,
            ownerId,
            assertActive,
          ),
        );
      } finally {
        active = false;
        account.expire();
        planning.expire();
      }
    });
  }
}
