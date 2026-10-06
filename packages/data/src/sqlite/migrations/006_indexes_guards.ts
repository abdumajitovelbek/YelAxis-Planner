import { defineMigration } from './migration';

const mutableSyncTables = [
  'profiles',
  'axes',
  'outcomes',
  'projects',
  'milestones',
  'actions',
  'notes',
  'project_secondary_outcomes',
  'milestone_projects',
  'milestone_actions',
  'planning_placements',
  'week_selections',
  'month_themes',
  'year_directions',
  'routines',
  'routine_generations',
  'routine_action_defaults',
  'routine_occurrences',
  'commitments',
  'time_blocks',
  'focus_selections',
  'contexts',
  'constraints',
  'review_checkpoints',
  'review_items',
  'templates',
  'reminders',
] as const;

const mutableSyncMetadataSql = mutableSyncTables
  .flatMap((table) => [
    `ALTER TABLE ${table} ADD COLUMN client_updated_at TEXT;`,
    `ALTER TABLE ${table} ADD COLUMN device_id TEXT;`,
    `ALTER TABLE ${table} ADD COLUMN base_snapshot_hash TEXT;`,
  ])
  .join('\n');

export const indexesGuardsMigration = defineMigration(
  6,
  'indexes_guards',
  `
    ${mutableSyncMetadataSql}

    CREATE INDEX idx_profiles_owner ON profiles(owner_id, id);
    CREATE INDEX idx_outcomes_axis ON outcomes(owner_id, axis_id, state, sort_key, id);
    CREATE INDEX idx_projects_axis ON projects(owner_id, axis_id, state, sort_key, id);
    CREATE INDEX idx_projects_primary_outcome ON projects(owner_id, primary_outcome_id, id);
    CREATE INDEX idx_milestones_outcome ON milestones(owner_id, outcome_id, state, sort_key, id);
    CREATE INDEX idx_actions_project ON actions(owner_id, project_id, state, sort_key, id);
    CREATE INDEX idx_actions_axis ON actions(owner_id, axis_id, state, sort_key, id);
    CREATE INDEX idx_notes_project ON notes(owner_id, project_id, state, sort_key, id);

    CREATE INDEX idx_actions_inbox_order
      ON actions(owner_id, sort_key, id)
      WHERE state = 'inbox' AND archived_at IS NULL AND deleted_at IS NULL;

    CREATE INDEX idx_project_secondary_outcomes_project
      ON project_secondary_outcomes(owner_id, project_id, outcome_id);
    CREATE INDEX idx_project_secondary_outcomes_outcome
      ON project_secondary_outcomes(owner_id, outcome_id, project_id);
    CREATE INDEX idx_milestone_projects_milestone
      ON milestone_projects(owner_id, milestone_id, project_id);
    CREATE INDEX idx_milestone_projects_project
      ON milestone_projects(owner_id, project_id, milestone_id);
    CREATE INDEX idx_milestone_actions_milestone
      ON milestone_actions(owner_id, milestone_id, action_id);
    CREATE INDEX idx_milestone_actions_action
      ON milestone_actions(owner_id, action_id, milestone_id);

    CREATE UNIQUE INDEX uq_active_placement_outcome
      ON planning_placements(owner_id, outcome_id)
      WHERE outcome_id IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX uq_active_placement_project
      ON planning_placements(owner_id, project_id)
      WHERE project_id IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX uq_active_placement_milestone
      ON planning_placements(owner_id, milestone_id)
      WHERE milestone_id IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX uq_active_placement_action
      ON planning_placements(owner_id, action_id)
      WHERE action_id IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;
    CREATE INDEX idx_placements_period
      ON planning_placements(owner_id, horizon, period_start_date, period_end_date, sort_key, id)
      WHERE archived_at IS NULL AND deleted_at IS NULL;

    CREATE UNIQUE INDEX uq_active_week_selection_action
      ON week_selections(owner_id, profile_id, period_start_date, period_end_date, action_id)
      WHERE action_id IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX uq_active_week_selection_project
      ON week_selections(owner_id, profile_id, period_start_date, period_end_date, project_id)
      WHERE project_id IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX uq_active_week_selection_milestone
      ON week_selections(owner_id, profile_id, period_start_date, period_end_date, milestone_id)
      WHERE milestone_id IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX uq_active_month_theme
      ON month_themes(owner_id, profile_id, period_key)
      WHERE archived_at IS NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX uq_active_year_direction
      ON year_directions(owner_id, profile_id, period_key)
      WHERE archived_at IS NULL AND deleted_at IS NULL;

    CREATE INDEX idx_routines_axis ON routines(owner_id, axis_id, state, sort_key, id);
    CREATE INDEX idx_routine_generations_window
      ON routine_generations(owner_id, routine_id, starts_on, ends_on, generation);
    CREATE INDEX idx_routine_occurrences_period
      ON routine_occurrences(owner_id, logical_period_key, state, id)
      WHERE deleted_at IS NULL;
    CREATE INDEX idx_routine_defaults_project
      ON routine_action_defaults(owner_id, project_id, routine_id, generation);

    CREATE UNIQUE INDEX uq_time_blocks_one_planned_action
      ON time_blocks(owner_id, action_id)
      WHERE action_id IS NOT NULL AND state = 'planned' AND deleted_at IS NULL;
    CREATE UNIQUE INDEX uq_time_blocks_one_planned_commitment
      ON time_blocks(owner_id, commitment_id)
      WHERE commitment_id IS NOT NULL AND state = 'planned' AND deleted_at IS NULL;
    CREATE INDEX idx_time_blocks_window
      ON time_blocks(owner_id, starts_at_utc, ends_at_utc, id)
      WHERE deleted_at IS NULL;
    CREATE INDEX idx_time_blocks_action_history
      ON time_blocks(owner_id, action_id, starts_at_utc DESC, id DESC)
      WHERE action_id IS NOT NULL AND deleted_at IS NULL;
    CREATE INDEX idx_time_blocks_occurrence_history
      ON time_blocks(owner_id, routine_occurrence_id, starts_at_utc DESC, id DESC)
      WHERE routine_occurrence_id IS NOT NULL AND deleted_at IS NULL;

    CREATE UNIQUE INDEX uq_active_focus_action
      ON focus_selections(owner_id, profile_id, local_date, action_id)
      WHERE action_id IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;
    CREATE UNIQUE INDEX uq_active_focus_occurrence
      ON focus_selections(owner_id, profile_id, local_date, routine_occurrence_id)
      WHERE routine_occurrence_id IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;
    CREATE INDEX idx_focus_day_order
      ON focus_selections(owner_id, profile_id, local_date, sort_key, id)
      WHERE archived_at IS NULL AND deleted_at IS NULL;

    CREATE UNIQUE INDEX uq_active_review_period
      ON review_checkpoints(owner_id, profile_id, review_type, period_start_date, period_end_date)
      WHERE archived_at IS NULL AND deleted_at IS NULL;
    CREATE INDEX idx_review_items_review
      ON review_items(owner_id, review_id, sort_key, id)
      WHERE deleted_at IS NULL;
    CREATE INDEX idx_reminders_due
      ON reminders(owner_id, state, remind_at_utc, id)
      WHERE deleted_at IS NULL;
    CREATE INDEX idx_domain_events_entity
      ON domain_events(owner_id, entity_type, entity_id, occurred_at DESC, id DESC)
      WHERE deleted_at IS NULL;
    CREATE INDEX idx_review_history
      ON review_checkpoints(owner_id, profile_id, review_type, period_start_date DESC, id DESC)
      WHERE deleted_at IS NULL;
    CREATE INDEX idx_sync_outbox_dispatch
      ON sync_outbox(owner_id, mutation_group_id, sequence, id, next_attempt_at)
      WHERE state IN ('pending', 'retry_wait') AND deleted_at IS NULL;
    CREATE INDEX idx_sync_outbox_retry
      ON sync_outbox(owner_id, next_attempt_at, mutation_group_id, sequence, id)
      WHERE state = 'retry_wait' AND deleted_at IS NULL;
    CREATE INDEX idx_sync_conflicts_open
      ON sync_conflicts(owner_id, state, updated_at, id)
      WHERE deleted_at IS NULL;
    CREATE INDEX idx_sync_checkpoints_cursor
      ON sync_checkpoints(owner_id, replica_id, server_cursor);

    CREATE TRIGGER trg_secondary_outcome_not_primary_insert
    BEFORE INSERT ON project_secondary_outcomes
    WHEN NEW.deleted_at IS NULL AND EXISTS (
      SELECT 1 FROM projects
      WHERE owner_id = NEW.owner_id AND id = NEW.project_id
        AND primary_outcome_id = NEW.outcome_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'secondary outcome cannot equal the primary outcome');
    END;

    CREATE TRIGGER trg_secondary_outcome_not_primary_update
    BEFORE UPDATE OF owner_id, project_id, outcome_id, deleted_at ON project_secondary_outcomes
    WHEN NEW.deleted_at IS NULL AND EXISTS (
      SELECT 1 FROM projects
      WHERE owner_id = NEW.owner_id AND id = NEW.project_id
        AND primary_outcome_id = NEW.outcome_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'secondary outcome cannot equal the primary outcome');
    END;

    CREATE TRIGGER trg_project_primary_not_secondary
    BEFORE UPDATE OF primary_outcome_id ON projects
    WHEN NEW.primary_outcome_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM project_secondary_outcomes
      WHERE owner_id = NEW.owner_id AND project_id = NEW.id
        AND outcome_id = NEW.primary_outcome_id AND deleted_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'primary outcome cannot also be secondary');
    END;

    CREATE TRIGGER trg_focus_max_three_insert
    BEFORE INSERT ON focus_selections
    WHEN NEW.archived_at IS NULL AND NEW.deleted_at IS NULL AND (
      SELECT COUNT(*) FROM focus_selections
      WHERE owner_id = NEW.owner_id AND profile_id = NEW.profile_id
        AND local_date = NEW.local_date AND archived_at IS NULL AND deleted_at IS NULL
    ) >= 3
    BEGIN
      SELECT RAISE(ABORT, 'day focus is limited to three active selections');
    END;

    CREATE TRIGGER trg_focus_max_three_update
    BEFORE UPDATE OF owner_id, profile_id, local_date, archived_at, deleted_at ON focus_selections
    WHEN NEW.archived_at IS NULL AND NEW.deleted_at IS NULL AND (
      SELECT COUNT(*) FROM focus_selections
      WHERE owner_id = NEW.owner_id AND profile_id = NEW.profile_id
        AND local_date = NEW.local_date AND archived_at IS NULL AND deleted_at IS NULL
        AND id <> OLD.id
    ) >= 3
    BEGIN
      SELECT RAISE(ABORT, 'day focus is limited to three active selections');
    END;

    CREATE TRIGGER trg_dated_occurrence_one_planned_block_insert
    BEFORE INSERT ON time_blocks
    WHEN NEW.state = 'planned' AND NEW.deleted_at IS NULL AND NEW.routine_occurrence_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM routine_occurrences
        WHERE owner_id = NEW.owner_id AND id = NEW.routine_occurrence_id
          AND occurrence_kind = 'dated'
      )
      AND EXISTS (
        SELECT 1 FROM time_blocks
        WHERE owner_id = NEW.owner_id AND routine_occurrence_id = NEW.routine_occurrence_id
          AND state = 'planned' AND deleted_at IS NULL
      )
    BEGIN
      SELECT RAISE(ABORT, 'dated occurrence already has a planned block');
    END;

    CREATE TRIGGER trg_dated_occurrence_one_planned_block_update
    BEFORE UPDATE OF owner_id, routine_occurrence_id, state, deleted_at ON time_blocks
    WHEN NEW.state = 'planned' AND NEW.deleted_at IS NULL AND NEW.routine_occurrence_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM routine_occurrences
        WHERE owner_id = NEW.owner_id AND id = NEW.routine_occurrence_id
          AND occurrence_kind = 'dated'
      )
      AND EXISTS (
        SELECT 1 FROM time_blocks
        WHERE owner_id = NEW.owner_id AND routine_occurrence_id = NEW.routine_occurrence_id
          AND state = 'planned' AND deleted_at IS NULL AND id <> OLD.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'dated occurrence already has a planned block');
    END;
  `,
);
