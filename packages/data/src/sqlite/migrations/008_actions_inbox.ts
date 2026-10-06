import { defineMigration } from './migration';

export const actionsInboxMigration = defineMigration(
  8,
  'actions_inbox',
  `
    CREATE UNIQUE INDEX uq_scheduled_action_reminder
      ON reminders(owner_id, action_id)
      WHERE action_id IS NOT NULL AND state = 'scheduled' AND deleted_at IS NULL;

    CREATE INDEX idx_reminders_action
      ON reminders(owner_id, action_id, state, id)
      WHERE action_id IS NOT NULL AND deleted_at IS NULL;

    CREATE TRIGGER trg_reminders_offset_insert
    BEFORE INSERT ON reminders
    WHEN NEW.schedule_kind = 'relative' AND
         (NEW.offset_minutes < -10080 OR NEW.offset_minutes > 10080)
    BEGIN
      SELECT RAISE(ABORT, 'invalid reminder offset');
    END;

    CREATE TRIGGER trg_reminders_offset_update
    BEFORE UPDATE OF schedule_kind, offset_minutes ON reminders
    WHEN NEW.schedule_kind = 'relative' AND
         (NEW.offset_minutes < -10080 OR NEW.offset_minutes > 10080)
    BEGIN
      SELECT RAISE(ABORT, 'invalid reminder offset');
    END;

    CREATE TRIGGER trg_actions_energy_insert
    BEFORE INSERT ON actions
    WHEN length(NEW.title) > 200 OR length(coalesce(NEW.note_text, '')) > 10000 OR
         coalesce(NEW.estimate_minutes, 1) > 10080 OR
         (NEW.energy IS NOT NULL AND NEW.energy NOT IN ('low', 'medium', 'high', 'focused'))
    BEGIN
      SELECT RAISE(ABORT, 'invalid action energy');
    END;

    CREATE TRIGGER trg_actions_energy_update
    BEFORE UPDATE OF title, note_text, estimate_minutes, energy ON actions
    WHEN length(NEW.title) > 200 OR length(coalesce(NEW.note_text, '')) > 10000 OR
         coalesce(NEW.estimate_minutes, 1) > 10080 OR
         (NEW.energy IS NOT NULL AND NEW.energy NOT IN ('low', 'medium', 'high', 'focused'))
    BEGIN
      SELECT RAISE(ABORT, 'invalid action energy');
    END;
  `,
);
