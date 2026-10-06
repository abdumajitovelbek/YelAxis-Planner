import { defineMigration } from './migration';

/**
 * Reviews.
 *
 * - `review_checkpoints` gains the monthly theme and yearly direction decision. Triggers enforce
 * structural rules only (which review type may hold energy, a theme, or a direction, and that
 * direction text goes with a `new` direction). Text caps stay on command input and the record
 * codecs, so an existing longer row can still be archived.
 * - `review_items` is rebuilt, copying every existing row, to add a typed `target_kind`, an Axis
 * target, a cleared-target marker (`target_deleted_at`), a versioned
 * `detail_json` (move period, Routine Occurrence identity), `archived_at`, and the decisions
 * `move`, `skip`, `commit`, and `note`. Legacy rows keep their values; their kind is derived
 * from the one target column they name. Its indexes are recreated and Action, Axis, and Routine
 * lookups added.
 * - History, draft, and Milestone order indexes back the bounded review read model.
 *
 * Nothing references `review_items`, so dropping the old table cascades to no other row, and the
 * migration runner's `PRAGMA foreign_key_check` proves every copied reference still resolves.
 */
export const reviewsMigration = defineMigration(
  11,
  'reviews',
  `
    ALTER TABLE review_checkpoints ADD COLUMN theme_text TEXT;
    ALTER TABLE review_checkpoints ADD COLUMN direction_choice TEXT
      CHECK (direction_choice IS NULL OR direction_choice IN ('continue', 'new', 'outdated'));
    ALTER TABLE review_checkpoints ADD COLUMN direction_text TEXT;

    CREATE TRIGGER trg_review_checkpoints_fields_insert
    BEFORE INSERT ON review_checkpoints
    WHEN (NEW.energy IS NOT NULL AND (
           NEW.review_type <> 'daily' OR NEW.energy NOT IN ('low', 'medium', 'high', 'focused')))
      OR (NEW.theme_text IS NOT NULL AND NEW.review_type <> 'monthly')
      OR (NEW.direction_choice IS NOT NULL AND NEW.review_type <> 'yearly')
      OR ((NEW.direction_text IS NOT NULL) <> (NEW.direction_choice IS 'new'))
    BEGIN
      SELECT RAISE(ABORT, 'review fields do not match the review type');
    END;

    CREATE TRIGGER trg_review_checkpoints_fields_update
    BEFORE UPDATE OF review_type, energy, theme_text, direction_choice, direction_text
      ON review_checkpoints
    WHEN (NEW.energy IS NOT NULL AND (
           NEW.review_type <> 'daily' OR NEW.energy NOT IN ('low', 'medium', 'high', 'focused')))
      OR (NEW.theme_text IS NOT NULL AND NEW.review_type <> 'monthly')
      OR (NEW.direction_choice IS NOT NULL AND NEW.review_type <> 'yearly')
      OR ((NEW.direction_text IS NOT NULL) <> (NEW.direction_choice IS 'new'))
    BEGIN
      SELECT RAISE(ABORT, 'review fields do not match the review type');
    END;

    CREATE TABLE review_items_rebuilt (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      review_id TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (
        target_kind IN (
          'axis', 'outcome', 'milestone', 'project', 'action', 'routine', 'routine_occurrence',
          'commitment'
        )
      ),
      axis_id TEXT,
      outcome_id TEXT,
      milestone_id TEXT,
      project_id TEXT,
      action_id TEXT,
      routine_id TEXT,
      commitment_id TEXT,
      target_deleted_at TEXT,
      decision TEXT NOT NULL CHECK (
        decision IN (
          'complete', 'carry', 'move', 'pause', 'cancel', 'skip', 'continue', 'archive', 'focus',
          'commit', 'note'
        )
      ),
      detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
      decision_note TEXT,
      sort_key TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      client_updated_at TEXT,
      device_id TEXT,
      base_snapshot_hash TEXT,
      UNIQUE (owner_id, id),
      CHECK (
        (axis_id IS NOT NULL) + (outcome_id IS NOT NULL) + (milestone_id IS NOT NULL) +
        (project_id IS NOT NULL) + (action_id IS NOT NULL) + (routine_id IS NOT NULL) +
        (commitment_id IS NOT NULL) = (target_deleted_at IS NULL)
      ),
      CHECK (
        target_deleted_at IS NOT NULL OR
        (target_kind = 'axis' AND axis_id IS NOT NULL) OR
        (target_kind = 'outcome' AND outcome_id IS NOT NULL) OR
        (target_kind = 'milestone' AND milestone_id IS NOT NULL) OR
        (target_kind = 'project' AND project_id IS NOT NULL) OR
        (target_kind = 'action' AND action_id IS NOT NULL) OR
        (target_kind IN ('routine', 'routine_occurrence') AND routine_id IS NOT NULL) OR
        (target_kind = 'commitment' AND commitment_id IS NOT NULL)
      ),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, review_id) REFERENCES review_checkpoints(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, axis_id) REFERENCES axes(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, outcome_id) REFERENCES outcomes(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, milestone_id) REFERENCES milestones(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, action_id) REFERENCES actions(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, routine_id) REFERENCES routines(owner_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (owner_id, commitment_id) REFERENCES commitments(owner_id, id) ON DELETE RESTRICT
    ) STRICT;

    INSERT INTO review_items_rebuilt (
      id, owner_id, review_id, target_kind, outcome_id, milestone_id, project_id, action_id,
      routine_id, commitment_id, decision, decision_note, sort_key, created_at, updated_at,
      local_revision, server_revision, deleted_at, client_updated_at, device_id, base_snapshot_hash
    )
    SELECT
      id, owner_id, review_id,
      CASE
        WHEN outcome_id IS NOT NULL THEN 'outcome'
        WHEN milestone_id IS NOT NULL THEN 'milestone'
        WHEN project_id IS NOT NULL THEN 'project'
        WHEN action_id IS NOT NULL THEN 'action'
        WHEN routine_id IS NOT NULL THEN 'routine'
        WHEN commitment_id IS NOT NULL THEN 'commitment'
      END,
      outcome_id, milestone_id, project_id, action_id, routine_id, commitment_id, decision,
      decision_note, sort_key, created_at, updated_at, local_revision, server_revision, deleted_at,
      client_updated_at, device_id, base_snapshot_hash
    FROM review_items
    ORDER BY rowid;

    DROP TABLE review_items;
    ALTER TABLE review_items_rebuilt RENAME TO review_items;

    CREATE INDEX idx_review_items_review
      ON review_items(owner_id, review_id, sort_key, id)
      WHERE deleted_at IS NULL;
    CREATE INDEX idx_review_items_outcome
      ON review_items(owner_id, outcome_id)
      WHERE outcome_id IS NOT NULL;
    CREATE INDEX idx_review_items_project
      ON review_items(owner_id, project_id)
      WHERE project_id IS NOT NULL;
    CREATE INDEX idx_review_items_milestone
      ON review_items(owner_id, milestone_id)
      WHERE milestone_id IS NOT NULL;
    CREATE INDEX idx_review_items_action
      ON review_items(owner_id, action_id)
      WHERE action_id IS NOT NULL;
    CREATE INDEX idx_review_items_axis
      ON review_items(owner_id, axis_id, id)
      WHERE axis_id IS NOT NULL;
    CREATE INDEX idx_review_items_routine
      ON review_items(owner_id, routine_id)
      WHERE routine_id IS NOT NULL;

    CREATE INDEX idx_review_history_all
      ON review_checkpoints(owner_id, profile_id, period_start_date DESC, id DESC)
      WHERE archived_at IS NULL AND deleted_at IS NULL;
    CREATE INDEX idx_review_drafts
      ON review_checkpoints(owner_id, profile_id, period_start_date DESC, id DESC)
      WHERE state = 'draft' AND deleted_at IS NULL;

    CREATE INDEX idx_milestones_order
      ON milestones(owner_id, state, sort_key, id)
      WHERE deleted_at IS NULL;
  `,
);
