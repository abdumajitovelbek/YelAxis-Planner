import { defineMigration } from './migration';

export const onboardingProgressMigration = defineMigration(
  7,
  'onboarding_progress',
  `
    ALTER TABLE profiles ADD COLUMN onboarding_schema_version INTEGER NOT NULL DEFAULT 1
      CHECK (onboarding_schema_version = 1);
    ALTER TABLE profiles ADD COLUMN onboarding_status TEXT NOT NULL DEFAULT 'not_started'
      CHECK (onboarding_status IN ('not_started', 'in_progress', 'completed'));
    ALTER TABLE profiles ADD COLUMN onboarding_step TEXT NOT NULL DEFAULT 'welcome'
      CHECK (onboarding_step IN (
        'welcome', 'defaults', 'context', 'axes', 'outcome', 'week', 'handbook'
      ));
    ALTER TABLE profiles ADD COLUMN onboarding_completed_steps_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(onboarding_completed_steps_json) AND
             json_type(onboarding_completed_steps_json) = 'array');
    ALTER TABLE profiles ADD COLUMN onboarding_skipped_steps_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(onboarding_skipped_steps_json) AND
             json_type(onboarding_skipped_steps_json) = 'array');
    ALTER TABLE profiles ADD COLUMN onboarding_draft_json TEXT
      CHECK (onboarding_draft_json IS NULL OR
             (json_valid(onboarding_draft_json) AND json_type(onboarding_draft_json) = 'object'));
    ALTER TABLE profiles ADD COLUMN onboarding_artifacts_json TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(onboarding_artifacts_json) AND
             json_type(onboarding_artifacts_json) = 'object');
    ALTER TABLE profiles ADD COLUMN onboarding_completed_at TEXT;
    ALTER TABLE profiles ADD COLUMN handbook_status TEXT NOT NULL DEFAULT 'not_started'
      CHECK (handbook_status IN ('not_started', 'in_progress', 'skipped', 'completed'));
    ALTER TABLE profiles ADD COLUMN handbook_lesson INTEGER NOT NULL DEFAULT 0
      CHECK (handbook_lesson BETWEEN 0 AND 4);
    ALTER TABLE profiles ADD COLUMN handbook_completed_lessons_json TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(handbook_completed_lessons_json) AND
             json_type(handbook_completed_lessons_json) = 'array');

    CREATE INDEX idx_profiles_onboarding
      ON profiles(owner_id, onboarding_status, onboarding_step, id)
      WHERE deleted_at IS NULL;
  `,
);
