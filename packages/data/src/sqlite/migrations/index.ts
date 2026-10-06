import { identityProfileMigration } from './001_identity_profile';
import { planningEntitiesMigration } from './002_planning_entities';
import { relationshipsPlacementsMigration } from './003_relationships_placements';
import { routinesScheduleMigration } from './004_routines_schedule';
import { reviewAuditOperationsMigration } from './005_review_audit_operations';
import { indexesGuardsMigration } from './006_indexes_guards';
import { onboardingProgressMigration } from './007_onboarding_progress';
import { actionsInboxMigration } from './008_actions_inbox';
import { horizonsSchedulingMigration } from './009_horizons_scheduling';
import { alignmentMigration } from './010_alignment';
import { reviewsMigration } from './011_reviews';
import { reminderTargetsMigration } from './012_reminder_targets';
import { reviewClearedListsMigration } from './013_review_cleared_lists';
import { accountLinkMigration } from './014_account_link';
import { searchMigration } from './015_search';
import { importRecoveryMigration } from './016_import_recovery';
import { notificationsMigration } from './017_notifications';
import { releaseQueryIndexesMigration } from './018_release_query_indexes';
import { searchRowStorageMigration } from './019_search_row_storage';
import type { MigrationSource } from './migration';

export const schemaMigrations: readonly MigrationSource[] = Object.freeze([
  identityProfileMigration,
  planningEntitiesMigration,
  relationshipsPlacementsMigration,
  routinesScheduleMigration,
  reviewAuditOperationsMigration,
  indexesGuardsMigration,
  onboardingProgressMigration,
  actionsInboxMigration,
  horizonsSchedulingMigration,
  alignmentMigration,
  reviewsMigration,
  reminderTargetsMigration,
  reviewClearedListsMigration,
  accountLinkMigration,
  searchMigration,
  importRecoveryMigration,
  notificationsMigration,
  releaseQueryIndexesMigration,
  searchRowStorageMigration,
]);

export const latestSchemaVersion = schemaMigrations.length;
