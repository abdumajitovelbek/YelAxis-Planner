/**
 * Prepared, owner-scoped statements of the sync store. Exported so tests can check their
 * query plans with EXPLAIN. Outbox scans walk the table in insertion (rowid) order: acknowledged
 * and superseded rows are removed, so the outbox holds only work that is still owed.
 */
export const syncSql = Object.freeze({
  identities: `
    SELECT * FROM planning_identities
    WHERE deleted_at IS NULL
    ORDER BY created_at, id
    LIMIT 2;`,
  identity: `
    SELECT * FROM planning_identities
    WHERE id = ? AND deleted_at IS NULL
    LIMIT 1;`,
  deletionState: `
    SELECT state FROM account_deletion_state
    WHERE owner_id = ? AND deleted_at IS NULL
    LIMIT 1;`,

  outboxCounts: `
    SELECT state, COUNT(*) AS count,
           SUM(CASE WHEN attempt_count > 0 AND state IN ('pending', 'sending', 'retry_wait')
                    THEN 1 ELSE 0 END) AS unconfirmed,
           MIN(CASE WHEN state = 'retry_wait' THEN next_attempt_at END) AS next_attempt_at
    FROM sync_outbox
    WHERE owner_id = ? AND deleted_at IS NULL
    GROUP BY state;`,
  scanOutbox: `
    SELECT rowid AS position, operation_id, mutation_group_id, command_id, actor, sequence,
           entity_type, entity_id, operation_kind, expected_revision, state, attempt_count,
           next_attempt_at, base_server_revision, base_snapshot_hash, document_payload_json
    FROM sync_outbox NOT INDEXED
    WHERE rowid >= ? AND owner_id = ? AND deleted_at IS NULL AND state <> 'acknowledged'
    ORDER BY rowid
    LIMIT ?;`,
  operationsForEntity: `
    SELECT rowid AS position, operation_id, mutation_group_id, command_id, actor, sequence,
           entity_type, entity_id, operation_kind, expected_revision, state, attempt_count,
           next_attempt_at, base_server_revision, base_snapshot_hash, document_payload_json
    FROM sync_outbox NOT INDEXED
    WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL
      AND state <> 'acknowledged'
    ORDER BY rowid
    LIMIT 1000;`,
  readGroup: `
    SELECT rowid AS position, operation_id, mutation_group_id, command_id, actor, sequence,
           entity_type, entity_id, operation_kind, expected_revision, state, attempt_count,
           next_attempt_at, base_server_revision, base_snapshot_hash, document_payload_json
    FROM sync_outbox
    WHERE owner_id = ? AND mutation_group_id = ? AND deleted_at IS NULL
    ORDER BY sequence
    LIMIT 1000;`,
  rewriteOperation: `
    UPDATE sync_outbox
    SET document_payload_json = COALESCE(?, document_payload_json),
        base_server_revision = COALESCE(?, base_server_revision),
        base_snapshot_hash = CASE WHEN ? THEN ? ELSE base_snapshot_hash END,
        updated_at = ?, local_revision = local_revision + 1
    WHERE owner_id = ? AND operation_id = ? AND deleted_at IS NULL
      AND state <> 'acknowledged';`,
  /** One statement for a whole acknowledged group: bases arrive as a JSON array. */
  rebaseQueuedOperations: `
    UPDATE sync_outbox
    SET base_server_revision = json_extract(base.value, '$.revision'),
        base_snapshot_hash = json_extract(base.value, '$.hash'),
        updated_at = ?, local_revision = local_revision + 1
    FROM json_each(?) AS base
    WHERE sync_outbox.owner_id = ?
      AND sync_outbox.entity_type = json_extract(base.value, '$.type')
      AND sync_outbox.entity_id = json_extract(base.value, '$.id')
      AND sync_outbox.deleted_at IS NULL AND sync_outbox.state <> 'acknowledged'
      AND sync_outbox.operation_kind <> 'create';`,
  removeOperation: `
    DELETE FROM sync_outbox WHERE owner_id = ? AND operation_id = ?;`,
  setStateWhere: `
    UPDATE sync_outbox
    SET state = ?, next_attempt_at = ?,
        attempt_count = CASE WHEN ? THEN 0 ELSE attempt_count END,
        updated_at = ?, local_revision = local_revision + 1
    WHERE owner_id = ? AND state = ? AND deleted_at IS NULL;`,

  readBaseSnapshot: `
    SELECT snapshot_hash, snapshot_payload_json, snapshot_server_revision
    FROM base_snapshots
    WHERE owner_id = ? AND entity_type = ? AND entity_id = ? AND deleted_at IS NULL;`,
  writeBaseSnapshot: `
    INSERT INTO base_snapshots (
      id, owner_id, entity_type, entity_id, snapshot_hash, snapshot_schema_version,
      snapshot_payload_json, snapshot_server_revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT (owner_id, entity_type, entity_id) DO UPDATE SET
      snapshot_hash = excluded.snapshot_hash,
      snapshot_payload_json = excluded.snapshot_payload_json,
      snapshot_server_revision = excluded.snapshot_server_revision,
      updated_at = excluded.updated_at,
      deleted_at = NULL,
      local_revision = base_snapshots.local_revision + 1;`,
  deleteBaseSnapshot: `
    DELETE FROM base_snapshots WHERE owner_id = ? AND entity_type = ? AND entity_id = ?;`,

  readDeletion: `
    SELECT server_revision, local_revision FROM deletion_ledger
    WHERE owner_id = ? AND entity_type = ? AND entity_id = ?;`,
  setDeletionServerRevision: `
    UPDATE deletion_ledger SET server_revision = ?, updated_at = ?
    WHERE owner_id = ? AND entity_type = ? AND entity_id = ?;`,
  recordRemoteDeletion: `
    INSERT INTO deletion_ledger (
      id, owner_id, entity_type, entity_id, local_revision, server_revision, deleted_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT (owner_id, entity_type, entity_id) DO UPDATE SET
      server_revision = MAX(deletion_ledger.server_revision, excluded.server_revision),
      updated_at = excluded.updated_at;`,
  clearDeletion: `
    DELETE FROM deletion_ledger WHERE owner_id = ? AND entity_type = ? AND entity_id = ?;`,

  createProfile: `
    INSERT INTO profiles (
      id, owner_id, planning_time_zone, week_start, time_format, defaults_confirmed_at,
      onboarding_status, onboarding_step, onboarding_artifacts_json, onboarding_completed_at,
      created_at, updated_at, client_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'completed', 'handbook', '{"axisIds":[],"commitments":[]}', ?, ?,
              ?, ?);`,

  openConflicts: `
    SELECT id, entity_type, entity_id, conflict_kind, state, candidate_payload_json,
           base_server_revision, remote_server_revision, resolution_strategy, resolved_at,
           created_at
    FROM sync_conflicts INDEXED BY idx_sync_conflicts_open
    WHERE owner_id = ? AND state = 'open' AND deleted_at IS NULL
    ORDER BY updated_at, id
    LIMIT 1000;`,
  conflictsAwaitingClosure: `
    SELECT id, entity_type, entity_id, conflict_kind, state, candidate_payload_json,
           base_server_revision, remote_server_revision, resolution_strategy, resolved_at,
           created_at
    FROM sync_conflicts INDEXED BY idx_sync_conflicts_open
    WHERE owner_id = ? AND state = 'resolved' AND deleted_at IS NULL
      AND json_extract(candidate_payload_json, '$.closure') = 'pending'
    ORDER BY updated_at, id
    LIMIT 1000;`,
  readConflict: `
    SELECT id, entity_type, entity_id, conflict_kind, state, candidate_payload_json,
           base_server_revision, remote_server_revision, resolution_strategy, resolved_at,
           created_at
    FROM sync_conflicts
    WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,
  conflictsForServerId: `
    SELECT id, entity_type, entity_id, conflict_kind, state, candidate_payload_json,
           base_server_revision, remote_server_revision, resolution_strategy, resolved_at,
           created_at
    FROM sync_conflicts
    WHERE owner_id = ? AND deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM json_each(sync_conflicts.candidate_payload_json, '$.serverConflictIds')
        WHERE value = ?
      )
    LIMIT 100;`,
  insertConflict: `
    INSERT INTO sync_conflicts (
      id, owner_id, entity_type, entity_id, conflict_kind, state, candidate_schema_version,
      candidate_payload_json, base_server_revision, remote_server_revision, resolution_strategy,
      resolved_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?);`,
  updateConflict: `
    UPDATE sync_conflicts
    SET state = COALESCE(?, state),
        candidate_payload_json = COALESCE(?, candidate_payload_json),
        resolution_strategy = COALESCE(?, resolution_strategy),
        resolved_at = COALESCE(?, resolved_at),
        updated_at = ?, local_revision = local_revision + 1
    WHERE owner_id = ? AND id = ? AND deleted_at IS NULL;`,

  readCheckpoint: `
    SELECT server_cursor, last_success_at FROM sync_checkpoints
    WHERE owner_id = ? AND replica_id = ? AND deleted_at IS NULL;`,
  writeCheckpoint: `
    INSERT INTO sync_checkpoints (
      id, owner_id, replica_id, server_cursor, last_success_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (owner_id, replica_id) DO UPDATE SET
      server_cursor = excluded.server_cursor,
      last_success_at = COALESCE(excluded.last_success_at, sync_checkpoints.last_success_at),
      updated_at = excluded.updated_at,
      local_revision = sync_checkpoints.local_revision + 1;`,

  tables: `
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name;`,
});

/** `UPDATE ... SET state` for one group, from the given states (one statement per shape). */
export function setGroupStateSql(fromCount: number): string {
  const placeholders = Array.from({ length: fromCount }, () => '?').join(', ');
  return `
    UPDATE sync_outbox
    SET state = ?, attempt_count = COALESCE(?, attempt_count),
        next_attempt_at = CASE WHEN ? THEN ? ELSE next_attempt_at END,
        updated_at = ?, local_revision = local_revision + 1
    WHERE owner_id = ? AND mutation_group_id = ? AND deleted_at IS NULL
      AND state IN (${placeholders});`;
}

/** Sync metadata of one live row (any state for join rows). */
export function setRecordSyncBaseSql(table: string, anyState: boolean): string {
  return `
    UPDATE ${table} SET server_revision = ?, base_snapshot_hash = ?
    WHERE owner_id = ? AND id = ?${anyState ? '' : ' AND deleted_at IS NULL'};`;
}

/** Live records and acknowledged ones of one table (first-upload progress). */
export function uploadProgressSql(table: string, anyState: boolean): string {
  return `
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN server_revision > 0 THEN 1 ELSE 0 END), 0) AS uploaded
    FROM ${table}
    WHERE owner_id = ?${anyState ? '' : ' AND deleted_at IS NULL'};`;
}
