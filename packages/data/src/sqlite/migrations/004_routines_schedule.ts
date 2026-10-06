import { defineMigration } from './migration';

export const routinesScheduleMigration = defineMigration(
  4,
  'routines_schedule',
  `
    CREATE TABLE routines (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      axis_id TEXT,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      description TEXT,
      state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'archived')),
      state_before_archive TEXT CHECK (
        state_before_archive IS NULL OR state_before_archive IN ('active', 'paused')
      ),
      sort_key TEXT NOT NULL,
      paused_effective_date TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, axis_id) REFERENCES axes(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE routine_generations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      routine_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      recurrence_schema_version INTEGER NOT NULL CHECK (recurrence_schema_version = 1),
      recurrence_payload_json TEXT NOT NULL CHECK (json_valid(recurrence_payload_json)),
      scheduling_mode TEXT NOT NULL DEFAULT 'day_flexible' CHECK (
        scheduling_mode IN ('day_flexible', 'time_specific')
      ),
      starts_on TEXT NOT NULL,
      ends_on TEXT,
      wall_time TEXT,
      duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
      zone_policy TEXT CHECK (zone_policy IS NULL OR zone_policy IN ('follow_profile', 'fixed_zone')),
      anchor_time_zone TEXT,
      dst_gap_policy TEXT CHECK (
        dst_gap_policy IS NULL OR dst_gap_policy IN ('shift_forward', 'skip')
      ),
      repeated_time_policy TEXT CHECK (
        repeated_time_policy IS NULL OR repeated_time_policy IN ('earlier_offset', 'later_offset')
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, routine_id, generation),
      CHECK (ends_on IS NULL OR starts_on <= ends_on),
      CHECK (
        (scheduling_mode = 'day_flexible' AND wall_time IS NULL AND zone_policy IS NULL AND anchor_time_zone IS NULL AND
         dst_gap_policy IS NULL AND repeated_time_policy IS NULL) OR
        (scheduling_mode = 'time_specific' AND wall_time IS NOT NULL AND zone_policy IS NOT NULL AND dst_gap_policy IS NOT NULL AND
         repeated_time_policy IS NOT NULL AND
         ((zone_policy = 'fixed_zone') = (anchor_time_zone IS NOT NULL)))
      ),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, routine_id) REFERENCES routines(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE routine_action_defaults (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      routine_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      project_id TEXT,
      note_text TEXT,
      estimate_minutes INTEGER CHECK (estimate_minutes IS NULL OR estimate_minutes > 0),
      energy TEXT,
      priority TEXT CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, routine_id, generation),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, routine_id, generation)
        REFERENCES routine_generations(owner_id, routine_id, generation) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE routine_occurrences (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      routine_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      logical_period_key TEXT NOT NULL,
      ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
      occurrence_kind TEXT NOT NULL CHECK (occurrence_kind IN ('dated', 'weekly_count')),
      state TEXT NOT NULL CHECK (state IN ('planned', 'completed', 'skipped')),
      target_count INTEGER,
      completed_count INTEGER,
      extra_completions_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (
        extra_completions_confirmed IN (0, 1)
      ),
      override_schema_version INTEGER,
      override_payload_json TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, routine_id, generation, logical_period_key, ordinal),
      CHECK (
        (occurrence_kind = 'dated' AND target_count IS NULL AND completed_count IS NULL AND
         extra_completions_confirmed = 0) OR
        (occurrence_kind = 'weekly_count' AND target_count > 0 AND
         completed_count >= 0 AND
         ((completed_count <= target_count AND extra_completions_confirmed = 0) OR
          (completed_count > target_count AND extra_completions_confirmed = 1)) AND
         ((state = 'completed' AND completed_count >= target_count) OR
          (state IN ('planned', 'skipped') AND completed_count < target_count)))
      ),
      CHECK (
        (override_schema_version IS NULL AND override_payload_json IS NULL) OR
        (override_schema_version = 1 AND override_payload_json IS NOT NULL AND
         json_valid(override_payload_json))
      ),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, routine_id, generation)
        REFERENCES routine_generations(owner_id, routine_id, generation) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE commitments (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      strength TEXT NOT NULL CHECK (strength IN ('hard', 'soft')),
      state TEXT NOT NULL CHECK (state IN ('planned', 'completed', 'canceled', 'archived')),
      state_before_archive TEXT CHECK (
        state_before_archive IS NULL OR state_before_archive IN ('planned', 'completed', 'canceled')
      ),
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

    CREATE TABLE time_blocks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      action_id TEXT,
      routine_occurrence_id TEXT,
      commitment_id TEXT,
      custom_title TEXT,
      starts_at_utc TEXT NOT NULL,
      ends_at_utc TEXT NOT NULL,
      time_zone TEXT NOT NULL CHECK (length(trim(time_zone)) > 0),
      state TEXT NOT NULL CHECK (state IN ('planned', 'completed', 'skipped', 'canceled')),
      superseded_by_id TEXT,
      overlap_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (overlap_confirmed IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK (
        (action_id IS NOT NULL) + (routine_occurrence_id IS NOT NULL) +
        (commitment_id IS NOT NULL) + (custom_title IS NOT NULL) = 1
      ),
      CHECK (custom_title IS NULL OR length(trim(custom_title)) > 0),
      CHECK (starts_at_utc < ends_at_utc),
      CHECK (superseded_by_id IS NULL OR state = 'canceled'),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, action_id) REFERENCES actions(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, routine_occurrence_id)
        REFERENCES routine_occurrences(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, commitment_id) REFERENCES commitments(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, superseded_by_id) REFERENCES time_blocks(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE focus_selections (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      action_id TEXT,
      routine_occurrence_id TEXT,
      local_date TEXT NOT NULL,
      sort_key TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK ((action_id IS NOT NULL) + (routine_occurrence_id IS NOT NULL) = 1),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, profile_id) REFERENCES profiles(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, action_id) REFERENCES actions(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, routine_occurrence_id)
        REFERENCES routine_occurrences(owner_id, id) ON DELETE RESTRICT
    ) STRICT;
  `,
);
