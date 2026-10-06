import { defineMigration } from './migration';

export const identityProfileMigration = defineMigration(
  1,
  'identity_profile',
  `
    CREATE TABLE planning_identities (
      id TEXT PRIMARY KEY,
      identity_kind TEXT NOT NULL CHECK (identity_kind IN ('local', 'account')),
      account_subject_id TEXT,
      replica_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      CHECK (
        (identity_kind = 'local' AND account_subject_id IS NULL) OR
        (identity_kind = 'account' AND account_subject_id IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      preferred_name TEXT,
      planning_time_zone TEXT,
      week_start TEXT CHECK (
        week_start IS NULL OR week_start IN (
          'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'
        )
      ),
      time_format TEXT CHECK (time_format IS NULL OR time_format IN ('12_hour', '24_hour')),
      locale_override TEXT,
      defaults_confirmed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_revision INTEGER NOT NULL DEFAULT 1 CHECK (local_revision > 0),
      server_revision INTEGER NOT NULL DEFAULT 0 CHECK (server_revision >= 0),
      deleted_at TEXT,
      UNIQUE (owner_id),
      UNIQUE (owner_id, id),
      FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
    ) STRICT;
  `,
);
