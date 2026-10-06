/**
 * Every table whose rows belong to exactly one planning identity through `owner_id` (identity
 * contract: every syncable row has exactly one owner). Ownership remapping moves all of them. A test
 * compares this list with the live schema and the schema inventory, so a new owned table cannot be
 * left behind by a link, a cancel, or a detach.
 */
export const ownedTables = Object.freeze([
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
  'domain_events',
  'undo_records',
  'deletion_ledger',
  'command_receipts',
  'base_snapshots',
  'sync_outbox',
  'sync_conflicts',
  'sync_checkpoints',
  'account_deletion_state',
  'account_link_backups',
  'search_documents',
  'search_tokens',
  'import_journal',
  'import_recovery_backups',
  'notification_preferences',
  'notification_receipts',
  'notification_routine_cursors',
] as const);
export type OwnedTable = (typeof ownedTables)[number];

/**
 * Tables whose rows refer to the owner's one Profile through `(owner_id, profile_id)`. Renaming the
 * Profile renames all of them; a test compares this list with the live schema's columns and
 * foreign keys.
 */
export const profileReferenceTables = Object.freeze([
  'week_selections',
  'month_themes',
  'year_directions',
  'focus_selections',
  'review_checkpoints',
] as const satisfies readonly OwnedTable[]);

/**
 * Tables of canonical records: every row carries a server revision and a base snapshot hash, which
 * describe a synchronized copy and are reset when a plan stops synchronizing.
 */
export const canonicalRecordTables = Object.freeze([
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
] as const satisfies readonly OwnedTable[]);
