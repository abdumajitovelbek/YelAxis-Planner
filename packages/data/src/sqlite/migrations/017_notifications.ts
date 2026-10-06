import { defineMigration } from './migration';

/** Device-only preferences, at-most-once dispatch receipts, and bounded recurrence catch-up. */
export const notificationsMigration = defineMigration(
  17,
  'notifications',
  `
  CREATE TABLE notification_preferences (
    owner_id TEXT PRIMARY KEY REFERENCES planning_identities(id) ON DELETE RESTRICT,
    alerts_enabled INTEGER NOT NULL DEFAULT 0 CHECK (alerts_enabled IN (0, 1)),
    privacy_mode INTEGER NOT NULL DEFAULT 1 CHECK (privacy_mode IN (0, 1)),
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE notification_receipts (
    owner_id TEXT NOT NULL REFERENCES planning_identities(id) ON DELETE RESTRICT,
    reminder_id TEXT NOT NULL,
    reminder_revision INTEGER NOT NULL CHECK (reminder_revision > 0),
    occurrence_key TEXT NOT NULL,
    due_at TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    delivery_status TEXT NOT NULL CHECK (delivery_status IN ('centre', 'missed', 'attempting', 'delivered', 'failed')),
    read_at TEXT,
    dismissed_at TEXT,
    PRIMARY KEY (owner_id, reminder_id, reminder_revision, occurrence_key)
  ) STRICT;
  CREATE INDEX idx_notification_centre
    ON notification_receipts(owner_id, observed_at DESC, reminder_id DESC, reminder_revision DESC, occurrence_key DESC)
    WHERE dismissed_at IS NULL;
  CREATE TABLE notification_routine_cursors (
    owner_id TEXT NOT NULL REFERENCES planning_identities(id) ON DELETE RESTRICT,
    reminder_id TEXT NOT NULL,
    reminder_revision INTEGER NOT NULL CHECK (reminder_revision > 0),
    next_date TEXT NOT NULL,
    PRIMARY KEY (owner_id, reminder_id, reminder_revision)
  ) STRICT;
`,
);
