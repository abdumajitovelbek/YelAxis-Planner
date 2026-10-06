import { defineMigration } from './migration';

export const relationshipsPlacementsMigration = defineMigration(
  3,
  'relationships_placements',
  `
    CREATE TABLE project_secondary_outcomes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      outcome_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, project_id, outcome_id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, outcome_id) REFERENCES outcomes(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE milestone_projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, milestone_id, project_id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, milestone_id) REFERENCES milestones(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE milestone_actions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, milestone_id, action_id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, milestone_id) REFERENCES milestones(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, action_id) REFERENCES actions(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE planning_placements (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      outcome_id TEXT,
      project_id TEXT,
      milestone_id TEXT,
      action_id TEXT,
      horizon TEXT NOT NULL CHECK (horizon IN ('year', 'month', 'week', 'day')),
      period_key TEXT NOT NULL,
      period_start_date TEXT NOT NULL,
      period_end_date TEXT NOT NULL,
      week_start TEXT CHECK (
        week_start IS NULL OR week_start IN (
          'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'
        )
      ),
      sort_key TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK (
        (outcome_id IS NOT NULL) + (project_id IS NOT NULL) +
        (milestone_id IS NOT NULL) + (action_id IS NOT NULL) = 1
      ),
      CHECK (
        (horizon = 'year' AND (outcome_id IS NOT NULL OR project_id IS NOT NULL)) OR
        (horizon = 'month') OR
        (horizon = 'week' AND outcome_id IS NULL) OR
        (horizon = 'day' AND action_id IS NOT NULL)
      ),
      CHECK (period_start_date <= period_end_date),
      CHECK ((horizon = 'week') = (week_start IS NOT NULL)),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, outcome_id) REFERENCES outcomes(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, milestone_id) REFERENCES milestones(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, action_id) REFERENCES actions(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE week_selections (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      action_id TEXT,
      project_id TEXT,
      milestone_id TEXT,
      period_start_date TEXT NOT NULL,
      period_end_date TEXT NOT NULL,
      week_start TEXT NOT NULL CHECK (
        week_start IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')
      ),
      sort_key TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      CHECK ((action_id IS NOT NULL) + (project_id IS NOT NULL) + (milestone_id IS NOT NULL) = 1),
      CHECK (period_start_date <= period_end_date),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, profile_id) REFERENCES profiles(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, action_id) REFERENCES actions(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, milestone_id) REFERENCES milestones(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE month_themes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      theme_text TEXT NOT NULL CHECK (length(trim(theme_text)) > 0),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, profile_id) REFERENCES profiles(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE year_directions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      direction_text TEXT NOT NULL CHECK (length(trim(direction_text)) > 0),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id, id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, profile_id) REFERENCES profiles(owner_id, id) ON DELETE RESTRICT
    ) STRICT;
  `,
);
