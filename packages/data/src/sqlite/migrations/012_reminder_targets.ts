import { defineMigration } from './migration';

/**
 * Review reminder definitions for Time Blocks, timed Routines, and saved reviews.
 * Indexes only: the `reminders` table already holds exactly one typed target, so no table is rebuilt,
 * no row is rewritten, and no trigger is added, and an upgrade from version 11 preserves every row.
 *
 * - At most one active `scheduled` reminder per Time Block, per Routine, and per review, like the
 * `uq_scheduled_action_reminder`. Earlier schemas wrote no reminders for these targets, so
 * no existing row can collide.
 * - Owner-scoped target lookups (any state) for the bounded reads that find a target's reminder.
 */
export const reminderTargetsMigration = defineMigration(
  12,
  'reminder_targets',
  `
    CREATE UNIQUE INDEX uq_scheduled_time_block_reminder
      ON reminders(owner_id, time_block_id)
      WHERE time_block_id IS NOT NULL AND state = 'scheduled' AND deleted_at IS NULL;

    CREATE UNIQUE INDEX uq_scheduled_routine_reminder
      ON reminders(owner_id, routine_id)
      WHERE routine_id IS NOT NULL AND state = 'scheduled' AND deleted_at IS NULL;

    CREATE UNIQUE INDEX uq_scheduled_review_reminder
      ON reminders(owner_id, review_id)
      WHERE review_id IS NOT NULL AND state = 'scheduled' AND deleted_at IS NULL;

    CREATE INDEX idx_reminders_time_block
      ON reminders(owner_id, time_block_id, state, id)
      WHERE time_block_id IS NOT NULL AND deleted_at IS NULL;

    CREATE INDEX idx_reminders_routine
      ON reminders(owner_id, routine_id, state, id)
      WHERE routine_id IS NOT NULL AND deleted_at IS NULL;

    CREATE INDEX idx_reminders_review
      ON reminders(owner_id, review_id, state, id)
      WHERE review_id IS NOT NULL AND deleted_at IS NULL;
  `,
);
