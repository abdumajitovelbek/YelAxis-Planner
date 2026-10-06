import { defineMigration } from './migration';

/** Additive overlap indexes: imported intervals need not have a fixed maximum duration. */
export const releaseQueryIndexesMigration = defineMigration(
  18,
  'release_query_indexes',
  `
  CREATE INDEX idx_time_blocks_overlap_end
    ON time_blocks(owner_id, ends_at_utc, starts_at_utc, id)
    WHERE deleted_at IS NULL;
  CREATE INDEX idx_placements_overlap_end
    ON planning_placements(owner_id, horizon, period_end_date, period_start_date, sort_key, id)
    WHERE archived_at IS NULL AND deleted_at IS NULL;
  CREATE INDEX idx_week_selections_overlap_end
    ON week_selections(owner_id, period_end_date, period_start_date, sort_key, id)
    WHERE archived_at IS NULL AND deleted_at IS NULL;
  CREATE INDEX idx_routine_occurrences_overlap_end
    ON routine_occurrences(owner_id,
      CASE WHEN occurrence_kind = 'weekly_count' THEN substr(logical_period_key, 12, 10)
        ELSE substr(logical_period_key, 1, 10) END,
      logical_period_key, id)
    WHERE deleted_at IS NULL;
`,
);
