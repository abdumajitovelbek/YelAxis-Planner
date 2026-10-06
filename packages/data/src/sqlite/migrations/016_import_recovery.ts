import { defineMigration } from './migration';

/** Device-only verified previews and pre-import recovery bundles; no canonical rows change. */
export const importRecoveryMigration = defineMigration(
  16,
  'import_recovery',
  `
  CREATE TABLE import_journal (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL UNIQUE,
    bundle_json TEXT NOT NULL CHECK (json_valid(bundle_json)),
    mode TEXT NOT NULL CHECK (mode IN ('merge', 'replace')),
    decisions_json TEXT NOT NULL CHECK (json_valid(decisions_json)),
    remap_json TEXT NOT NULL CHECK (json_valid(remap_json)),
    destination_digest TEXT NOT NULL CHECK (length(destination_digest) = 64),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (owner_id, id),
    FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE import_recovery_backups (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    bundle_json TEXT NOT NULL CHECK (json_valid(bundle_json)),
    data_sha256 TEXT NOT NULL CHECK (length(data_sha256) = 64),
    record_count INTEGER NOT NULL CHECK (record_count >= 0),
    verified_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (owner_id, id),
    FOREIGN KEY (owner_id) REFERENCES planning_identities(id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX idx_import_recovery_backups_owner ON import_recovery_backups(owner_id, created_at DESC, id DESC);
`,
);
