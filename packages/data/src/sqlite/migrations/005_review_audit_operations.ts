import { defineMigration } from './migration';

export const reviewAuditOperationsMigration = defineMigration(
  5,
  'review_audit_operations',
  `
    CREATE TABLE contexts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK (
        category IN (
          'identity_locale', 'roles_axes', 'availability', 'commitments',
          'preferences', 'goals', 'boundaries', 'sensitive_notes'
        )
      ),
      context_key TEXT NOT NULL CHECK (length(trim(context_key)) > 0),
      value_text TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('user', 'device', 'import')),
      sensitivity TEXT NOT NULL CHECK (
        sensitivity IN ('normal', 'sensitive')
      ),
      strength TEXT NOT NULL CHECK (strength IN ('hard', 'soft', 'unknown')),
      future_sharing_state TEXT NOT NULL DEFAULT 'not_shared' CHECK (
        future_sharing_state = 'not_shared'
      ),
      state TEXT NOT NULL CHECK (state IN ('active', 'archived')),
      state_before_archive TEXT CHECK (state_before_archive IS NULL OR state_before_archive = 'active'),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE constraints (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      context_id TEXT,
      constraint_kind TEXT NOT NULL CHECK (
        constraint_kind IN ('availability', 'protected_interval', 'capacity', 'other')
      ),
      strength TEXT NOT NULL CHECK (strength IN ('hard', 'soft', 'unknown')),
      value_schema_version INTEGER NOT NULL CHECK (value_schema_version = 1),
      value_payload_json TEXT NOT NULL CHECK (json_valid(value_payload_json)),
      state TEXT NOT NULL CHECK (state IN ('active', 'archived')),
      state_before_archive TEXT CHECK (state_before_archive IS NULL OR state_before_archive = 'active'),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, context_id) REFERENCES contexts(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE review_checkpoints (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      review_type TEXT NOT NULL CHECK (review_type IN ('daily', 'weekly', 'monthly', 'yearly')),
      period_key TEXT NOT NULL,
      period_start_date TEXT NOT NULL,
      period_end_date TEXT NOT NULL,
      week_start TEXT CHECK (
        week_start IS NULL OR week_start IN (
          'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'
        )
      ),
      notes TEXT,
      energy TEXT,
      state TEXT NOT NULL CHECK (state IN ('draft', 'skipped', 'completed', 'archived')),
      state_before_archive TEXT CHECK (
        state_before_archive IS NULL OR state_before_archive IN ('draft', 'skipped', 'completed')
      ),
      completed_at TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK (period_start_date <= period_end_date),
      CHECK ((review_type = 'weekly') = (week_start IS NOT NULL)),
      CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, profile_id) REFERENCES profiles(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE review_items (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      review_id TEXT NOT NULL,
      outcome_id TEXT,
      milestone_id TEXT,
      project_id TEXT,
      action_id TEXT,
      routine_id TEXT,
      commitment_id TEXT,
      decision TEXT NOT NULL CHECK (
        decision IN ('complete', 'carry', 'pause', 'cancel', 'continue', 'archive', 'focus')
      ),
      decision_note TEXT,
      sort_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK (
        (outcome_id IS NOT NULL) + (milestone_id IS NOT NULL) + (project_id IS NOT NULL) +
        (action_id IS NOT NULL) + (routine_id IS NOT NULL) + (commitment_id IS NOT NULL) = 1
      ),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, review_id) REFERENCES review_checkpoints(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, outcome_id) REFERENCES outcomes(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, milestone_id) REFERENCES milestones(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, action_id) REFERENCES actions(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, routine_id) REFERENCES routines(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, commitment_id) REFERENCES commitments(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE templates (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      template_schema_version INTEGER NOT NULL CHECK (template_schema_version = 1),
      template_payload_json TEXT NOT NULL CHECK (json_valid(template_payload_json)),
      state TEXT NOT NULL CHECK (state IN ('active', 'archived')),
      state_before_archive TEXT CHECK (state_before_archive IS NULL OR state_before_archive = 'active'),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE reminders (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      action_id TEXT,
      time_block_id TEXT,
      routine_id TEXT,
      review_id TEXT,
      schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('at', 'relative')),
      remind_at_utc TEXT NOT NULL,
      offset_minutes INTEGER,
      time_zone TEXT NOT NULL CHECK (length(trim(time_zone)) > 0),
      state TEXT NOT NULL CHECK (state IN ('scheduled', 'delivered', 'canceled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK (
        (action_id IS NOT NULL) + (time_block_id IS NOT NULL) +
        (routine_id IS NOT NULL) + (review_id IS NOT NULL) = 1
      ),
      CHECK (
        (schedule_kind = 'at' AND offset_minutes IS NULL) OR
        (schedule_kind = 'relative' AND offset_minutes IS NOT NULL)
      ),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, action_id) REFERENCES actions(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, time_block_id) REFERENCES time_blocks(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, routine_id) REFERENCES routines(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, review_id) REFERENCES review_checkpoints(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE domain_events (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      actor TEXT NOT NULL CHECK (actor IN ('user', 'import', 'sync', 'intelligence_proposal')),
      event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
      entity_type TEXT NOT NULL CHECK (length(trim(entity_type)) > 0),
      entity_id TEXT NOT NULL,
      payload_schema_version INTEGER NOT NULL CHECK (payload_schema_version = 1),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, command_id, sequence),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE undo_records (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('available', 'applied', 'expired')),
      descriptor_schema_version INTEGER NOT NULL CHECK (descriptor_schema_version = 1),
      descriptor_payload_json TEXT NOT NULL CHECK (json_valid(descriptor_payload_json)),
      expires_at TEXT,
      applied_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, command_id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE deletion_ledger (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (length(trim(entity_type)) > 0),
      entity_id TEXT NOT NULL,
      local_revision INTEGER NOT NULL CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, entity_type, entity_id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE command_receipts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      actor TEXT NOT NULL CHECK (actor IN ('user', 'import', 'sync', 'intelligence_proposal')),
      accepted_at TEXT NOT NULL,
      receipt_schema_version INTEGER NOT NULL CHECK (receipt_schema_version = 1),
      receipt_payload_json TEXT NOT NULL CHECK (json_valid(receipt_payload_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, command_id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE base_snapshots (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (length(trim(entity_type)) > 0),
      entity_id TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      snapshot_schema_version INTEGER NOT NULL CHECK (snapshot_schema_version = 1),
      snapshot_payload_json TEXT NOT NULL CHECK (json_valid(snapshot_payload_json)),
      snapshot_server_revision INTEGER NOT NULL CHECK (snapshot_server_revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, entity_type, entity_id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE sync_outbox (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      mutation_group_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      actor TEXT NOT NULL CHECK (actor IN ('user', 'import', 'sync', 'intelligence_proposal')),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL CHECK (
        operation_kind IN ('create', 'update', 'delete')
      ),
      expected_revision INTEGER CHECK (expected_revision IS NULL OR expected_revision >= 0),
      document_schema_version INTEGER NOT NULL CHECK (document_schema_version = 1),
      document_payload_json TEXT NOT NULL CHECK (json_valid(document_payload_json)),
      base_server_revision INTEGER NOT NULL CHECK (base_server_revision >= 0),
      base_snapshot_hash TEXT,
      state TEXT NOT NULL CHECK (
        state IN ('pending', 'sending', 'retry_wait', 'blocked_conflict', 'acknowledged', 'dead_letter')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, operation_id),
      UNIQUE (owner_id, mutation_group_id, sequence),
      CHECK (
        (operation_kind = 'create' AND expected_revision IS NULL) OR
        (operation_kind IN ('update', 'delete') AND expected_revision IS NOT NULL)
      ),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE sync_conflicts (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      conflict_kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'superseded')),
      candidate_schema_version INTEGER NOT NULL CHECK (candidate_schema_version = 1),
      candidate_payload_json TEXT NOT NULL CHECK (json_valid(candidate_payload_json)),
      base_server_revision INTEGER NOT NULL CHECK (base_server_revision >= 0),
      remote_server_revision INTEGER NOT NULL CHECK (remote_server_revision >= 0),
      resolution_strategy TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE sync_checkpoints (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      replica_id TEXT NOT NULL,
      server_cursor TEXT,
      last_success_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, replica_id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE account_deletion_state (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      request_id TEXT,
      state TEXT NOT NULL CHECK (
        state IN ('none', 'requested', 'pending', 'confirmed', 'failed_recoverable')
      ),
      requested_at TEXT,
      confirmed_at TEXT,
      recoverable_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
    ) STRICT;
  `,
);
