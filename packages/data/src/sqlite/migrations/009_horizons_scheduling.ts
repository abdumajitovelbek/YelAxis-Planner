import { defineMigration } from './migration';

/**
 * planning read-model indexes and text guards. No table is rebuilt and no row is rewritten, so an
 * upgrade from version 8 preserves every existing record. The unfinished-Action index covers only
 * the Backlog and carry-forward states so the Action Inbox plan keeps `idx_actions_inbox_order`.
 */
export const horizonsSchedulingMigration = defineMigration(
  9,
  'horizons_scheduling',
  `
    CREATE INDEX idx_actions_planning_state
      ON actions(owner_id, state, sort_key, id)
      WHERE state IN ('planned', 'in_progress') AND archived_at IS NULL AND deleted_at IS NULL;

    CREATE INDEX idx_week_selections_period
      ON week_selections(owner_id, period_start_date, period_end_date, sort_key, id)
      WHERE archived_at IS NULL AND deleted_at IS NULL;

    CREATE INDEX idx_routine_occurrences_history
      ON routine_occurrences(owner_id, routine_id, updated_at DESC, id DESC)
      WHERE deleted_at IS NULL;

    CREATE INDEX idx_routine_occurrences_override_date
      ON routine_occurrences(owner_id, json_extract(override_payload_json, '$.date'), id)
      WHERE deleted_at IS NULL;

    CREATE INDEX idx_constraints_kind
      ON constraints(owner_id, constraint_kind, state, id)
      WHERE deleted_at IS NULL;

    CREATE INDEX idx_templates_title
      ON templates(owner_id, state, title, id)
      WHERE deleted_at IS NULL;

    CREATE INDEX idx_outcomes_target_end
      ON outcomes(owner_id, target_end_date, id)
      WHERE deleted_at IS NULL;

    CREATE INDEX idx_milestones_target_end
      ON milestones(owner_id, target_end_date, id)
      WHERE deleted_at IS NULL;

    CREATE INDEX idx_projects_target_end
      ON projects(owner_id, target_end_date, id)
      WHERE deleted_at IS NULL;

    CREATE TRIGGER trg_month_theme_text_insert
    BEFORE INSERT ON month_themes
    WHEN length(NEW.theme_text) > 2000
    BEGIN
      SELECT RAISE(ABORT, 'month theme text is too long');
    END;

    CREATE TRIGGER trg_month_theme_text_update
    BEFORE UPDATE OF theme_text ON month_themes
    WHEN length(NEW.theme_text) > 2000
    BEGIN
      SELECT RAISE(ABORT, 'month theme text is too long');
    END;

    CREATE TRIGGER trg_year_direction_text_insert
    BEFORE INSERT ON year_directions
    WHEN length(NEW.direction_text) > 2000
    BEGIN
      SELECT RAISE(ABORT, 'year direction text is too long');
    END;

    CREATE TRIGGER trg_year_direction_text_update
    BEFORE UPDATE OF direction_text ON year_directions
    WHEN length(NEW.direction_text) > 2000
    BEGIN
      SELECT RAISE(ABORT, 'year direction text is too long');
    END;
  `,
);
