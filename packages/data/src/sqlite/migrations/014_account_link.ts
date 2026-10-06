import { defineMigration } from './migration';

/**
 * optional account: linking a local plan to an account and the account lifecycle
 * (identity contract).
 *
 * - `planning_identities` gains the link of a local plan to an account. Linking creates the account
 * identity with `link_id` (the command id of every initial upload group), `link_source_identity_id`
 * (the local identity it replaced, kept so cancel can reverse the remap),
 * `link_source_profile_id` (the local Profile id it replaced with the account's Profile id, which
 * is derived from the account subject; null when the Profile already had it or the plan had
 * none), and `link_started_at`. The identity is linking while `link_started_at` is set and
 * `linked_at` is not; `linked_at` is set once every initial group is acknowledged and a pull
 * checkpoint exists. A replica opened for an account without a local plan is linked from its
 * creation. Only account identities hold these columns, and the sources only with a link.
 * - `account_deletion_state` remembers the person's choice for this device's copy, so a retried or
 * resumed deletion applies the same choice.
 * - `account_link_backups` keeps the verified canonical backup made before linking, until linkage
 * . It is owned like every other row, so ownership remapping covers it, and it is
 * never a synchronized record.
 * - An outbox index finds the initial upload groups of a link by their command id.
 *
 * Columns are only added and one table and two indexes created: no row is rewritten, so an upgrade
 * from version 13 preserves every record, and an existing account identity reads as not linking.
 */
export const accountLinkMigration = defineMigration(
  14,
  'account_link',
  `
    ALTER TABLE planning_identities ADD COLUMN link_id TEXT
      CHECK (link_id IS NULL OR identity_kind = 'account');
    ALTER TABLE planning_identities ADD COLUMN link_source_identity_id TEXT
      CHECK (link_source_identity_id IS NULL OR link_id IS NOT NULL);
    ALTER TABLE planning_identities ADD COLUMN link_source_profile_id TEXT
      CHECK (link_source_profile_id IS NULL OR link_id IS NOT NULL);
    ALTER TABLE planning_identities ADD COLUMN link_started_at TEXT
      CHECK ((link_started_at IS NULL) = (link_id IS NULL));
    ALTER TABLE planning_identities ADD COLUMN linked_at TEXT
      CHECK (linked_at IS NULL OR identity_kind = 'account');

    ALTER TABLE account_deletion_state ADD COLUMN local_copy_choice TEXT
      CHECK (local_copy_choice IS NULL OR local_copy_choice IN ('keep', 'delete'));

    CREATE TABLE account_link_backups (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      data_sha256 TEXT NOT NULL CHECK (length(data_sha256) = 64),
      record_count INTEGER NOT NULL CHECK (record_count >= 0),
      sync_was_pending INTEGER NOT NULL CHECK (sync_was_pending IN (0, 1)),
      bundle_json TEXT NOT NULL CHECK (json_valid(bundle_json)),
      verified_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner_id, id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX idx_account_link_backups_owner
      ON account_link_backups(owner_id, created_at DESC, id DESC);

    CREATE INDEX idx_sync_outbox_command
      ON sync_outbox(owner_id, command_id, state, mutation_group_id);
  `,
);
