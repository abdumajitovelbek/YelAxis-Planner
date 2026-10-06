import { defineMigration } from './migration';

export const planningEntitiesMigration = defineMigration(
  2,
  'planning_entities',
  `
    CREATE TABLE axes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      purpose TEXT,
      color_token TEXT,
      icon_name TEXT,
      state TEXT NOT NULL CHECK (state IN ('active', 'archived')),
      state_before_archive TEXT CHECK (state_before_archive IS NULL OR state_before_archive = 'active'),
      sort_key TEXT NOT NULL,
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

    CREATE TABLE outcomes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      axis_id TEXT,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      success_definition TEXT NOT NULL CHECK (length(trim(success_definition)) > 0),
      state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'achieved', 'abandoned', 'archived')),
      state_before_archive TEXT CHECK (
        state_before_archive IS NULL OR state_before_archive IN ('active', 'paused', 'achieved', 'abandoned')
      ),
      progress_mode TEXT NOT NULL CHECK (progress_mode IN ('none', 'manual', 'milestone_derived')),
      progress_percent INTEGER CHECK (progress_percent IS NULL OR progress_percent BETWEEN 0 AND 100),
      target_start_date TEXT,
      target_end_date TEXT,
      sort_key TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK (target_start_date IS NULL OR target_end_date IS NULL OR target_start_date <= target_end_date),
      CHECK ((progress_mode = 'manual') = (progress_percent IS NOT NULL)),
      CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, axis_id) REFERENCES axes(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      axis_id TEXT,
      primary_outcome_id TEXT,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      description TEXT,
      desired_result TEXT,
      notes TEXT,
      state TEXT NOT NULL CHECK (state IN ('idea', 'active', 'blocked', 'paused', 'completed', 'archived')),
      state_before_archive TEXT CHECK (
        state_before_archive IS NULL OR state_before_archive IN ('idea', 'active', 'blocked', 'paused', 'completed')
      ),
      target_start_date TEXT,
      target_end_date TEXT,
      sort_key TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK (desired_result IS NULL OR length(trim(desired_result)) > 0),
      CHECK (
        desired_result IS NOT NULL OR state = 'idea' OR
        (state = 'archived' AND state_before_archive = 'idea')
      ),
      CHECK (target_start_date IS NULL OR target_end_date IS NULL OR target_start_date <= target_end_date),
      CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, axis_id) REFERENCES axes(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, primary_outcome_id) REFERENCES outcomes(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE milestones (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      outcome_id TEXT NOT NULL,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      measurable_checkpoint TEXT NOT NULL CHECK (length(trim(measurable_checkpoint)) > 0),
      state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'canceled', 'archived')),
      state_before_archive TEXT CHECK (
        state_before_archive IS NULL OR state_before_archive IN ('active', 'completed', 'canceled')
      ),
      target_start_date TEXT,
      target_end_date TEXT,
      sort_key TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK (target_start_date IS NULL OR target_end_date IS NULL OR target_start_date <= target_end_date),
      CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, outcome_id) REFERENCES outcomes(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE actions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      axis_id TEXT,
      project_id TEXT,
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      note_text TEXT,
      state TEXT NOT NULL CHECK (
        state IN ('inbox', 'planned', 'scheduled', 'in_progress', 'completed', 'canceled', 'archived')
      ),
      state_before_archive TEXT CHECK (
        state_before_archive IS NULL OR state_before_archive IN (
          'inbox', 'planned', 'scheduled', 'in_progress', 'completed', 'canceled'
        )
      ),
      estimate_minutes INTEGER CHECK (estimate_minutes IS NULL OR estimate_minutes > 0),
      energy TEXT,
      priority TEXT CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high')),
      due_date TEXT,
      due_at_utc TEXT,
      due_time_zone TEXT,
      converted_to_type TEXT CHECK (converted_to_type IS NULL OR converted_to_type IN ('note', 'project')),
      converted_to_id TEXT,
      capture_origin TEXT NOT NULL DEFAULT 'global_capture' CHECK (
        capture_origin IN (
          'global_capture', 'today', 'plan', 'axis', 'review', 'inbox', 'project', 'onboarding',
          'import', 'other'
        )
      ),
      sort_key TEXT NOT NULL,
      completed_at TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK (due_date IS NULL OR due_at_utc IS NULL),
      CHECK ((due_at_utc IS NULL) = (due_time_zone IS NULL)),
      CHECK ((converted_to_type IS NULL) = (converted_to_id IS NULL)),
      CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
      CHECK ((state = 'archived') = (state_before_archive IS NOT NULL)),
      CHECK (
        (state = 'completed' OR (state = 'archived' AND state_before_archive = 'completed')) =
        (completed_at IS NOT NULL)
      ),
      CHECK (converted_to_type IS NULL OR state = 'archived'),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, axis_id) REFERENCES axes(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      axis_id TEXT,
      project_id TEXT,
      title TEXT,
      body TEXT,
      state TEXT NOT NULL CHECK (state IN ('active', 'archived')),
      state_before_archive TEXT CHECK (state_before_archive IS NULL OR state_before_archive = 'active'),
      sort_key TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK (length(trim(coalesce(title, ''))) > 0 OR length(trim(coalesce(body, ''))) > 0),
      CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, axis_id) REFERENCES axes(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE RESTRICT
    ) STRICT;
  `,
);
