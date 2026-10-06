import { defineMigration } from './migration';

/**
 * alignment read-model indexes. Indexes only: no table is rebuilt, no row is
 * rewritten, and no trigger is added, so an upgrade from version 9 preserves every record.
 *
 * - Ordered, owner-scoped scans of current Axes, Outcomes, and Projects (lists and link candidates).
 * - Notes by Axis, for Axis archive and delete impact.
 * - Placements and week selections by target in any archive state: the planning unique indexes cover
 * only active rows, and permanent delete must find the target's archived history rows too.
 * - Review items by Outcome, Project, and Milestone, which block permanent delete.
 *
 * Text length caps stay on command input only: a trigger would stop archiving an
 * existing longer row.
 */
export const alignmentMigration = defineMigration(
  10,
  'alignment',
  `
    CREATE INDEX idx_axes_order
      ON axes(owner_id, state, sort_key, id)
      WHERE deleted_at IS NULL;

    CREATE INDEX idx_outcomes_order
      ON outcomes(owner_id, state, sort_key, id)
      WHERE deleted_at IS NULL;

    CREATE INDEX idx_projects_order
      ON projects(owner_id, state, sort_key, id)
      WHERE deleted_at IS NULL;

    CREATE INDEX idx_notes_axis
      ON notes(owner_id, axis_id, state, sort_key, id);

    CREATE INDEX idx_placements_outcome_all
      ON planning_placements(owner_id, outcome_id, id)
      WHERE outcome_id IS NOT NULL;

    CREATE INDEX idx_placements_project_all
      ON planning_placements(owner_id, project_id, id)
      WHERE project_id IS NOT NULL;

    CREATE INDEX idx_placements_milestone_all
      ON planning_placements(owner_id, milestone_id, id)
      WHERE milestone_id IS NOT NULL;

    CREATE INDEX idx_week_selections_project
      ON week_selections(owner_id, project_id, id)
      WHERE project_id IS NOT NULL;

    CREATE INDEX idx_week_selections_milestone
      ON week_selections(owner_id, milestone_id, id)
      WHERE milestone_id IS NOT NULL;

    CREATE INDEX idx_review_items_outcome
      ON review_items(owner_id, outcome_id)
      WHERE outcome_id IS NOT NULL;

    CREATE INDEX idx_review_items_project
      ON review_items(owner_id, project_id)
      WHERE project_id IS NOT NULL;

    CREATE INDEX idx_review_items_milestone
      ON review_items(owner_id, milestone_id)
      WHERE milestone_id IS NOT NULL;
  `,
);
