/** SQLite repositories, migrations, and rebuildable projections live here. */
export const dataPackageMarker = '@yelaxis/data';

export { actionCanonicalDocumentSchema } from './application/action-codec';
export type { ActionCanonicalDocument } from './application/action-codec';
export {
  commitmentDocumentSchema,
  focusSelectionDocumentSchema,
  horizonPeriodSchema,
  monthThemeDocumentSchema,
  noteDocumentSchema,
  planningPlacementDocumentSchema,
  projectDocumentSchema,
  reminderDocumentSchema,
  templateDocumentSchema,
  timeBlockDocumentSchema,
  yearDirectionDocumentSchema,
} from './application/planning-codecs';
export {
  routineActionDefaultsDocumentSchema,
  routineDocumentSchema,
  routineGenerationDocumentSchema,
  routineGenerationId,
  routineOccurrenceDocumentSchema,
} from './application/routine-codecs';
export {
  axisDocumentSchema,
  constraintDocumentSchema,
  constraintValueSchema,
  milestoneDocumentSchema,
  outcomeDocumentSchema,
} from './application/horizon-codecs';
export type {
  FocusSelectionDocument,
  NoteDocument,
  PlanningPlacementDocument,
  ProjectDocument,
  ReminderDocument,
  TimeBlockDocument,
} from './application/planning-codecs';
export {
  reviewDocumentSchema,
  reviewItemDocumentSchema,
  reviewItemTargetKinds,
} from './application/review-codecs';
export type { ReviewDocument, ReviewItemDocument } from './application/review-codecs';
export {
  alignmentLinkTables,
  milestoneActionDocumentSchema,
  milestoneProjectDocumentSchema,
  projectSecondaryOutcomeDocumentSchema,
} from './application/relationship-codecs';
export type {
  AlignmentLinkTable,
  MilestoneActionDocument,
  MilestoneProjectDocument,
  ProjectSecondaryOutcomeDocument,
} from './application/relationship-codecs';
export {
  CanonicalCodecRegistry,
  createDefaultCanonicalCodecRegistry,
} from './application/canonical-codecs';
export type { CanonicalRecordCodec } from './application/canonical-codecs';
export { DataAdapterError } from './application/errors';
export type { DataAdapterErrorCode } from './application/errors';
export { SqliteOnboardingPersistence } from './application/onboarding-adapter';
export {
  createSqliteApplicationAdapters,
  SqliteIdentityContext,
  SqliteUnitOfWork,
} from './application/sqlite-adapters';
export type {
  SqliteApplicationAdapters,
  SqliteIdentityContextOptions,
  SqliteUnitOfWorkOptions,
} from './application/sqlite-adapters';
export {
  listActionBlockHistory,
  listInboxActions,
  listOutboxDispatchPage,
  listTimeBlocksInWindow,
} from './queries/core-queries';
export { SqliteActionPlanningQueries } from './queries/action-planning';
export type {
  ActionDeleteImpactRecords,
  ActionMilestoneChoice,
  ActionProjectChoice,
} from './queries/action-planning';
export { alignmentQuerySql, SqliteAlignmentQueries } from './queries/alignment-queries';
export { planningQuerySql, SqlitePlanningQueries } from './queries/planning-queries';
export { blockLookbackMs, SqliteTodayQueries, todayQuerySql } from './queries/today-queries';
export { reviewItemRowLimit, reviewQuerySql, SqliteReviewQueries } from './queries/review-queries';
export { SerializedSqliteDriver } from './sqlite/serialized-driver';
export type {
  InboxActionProjection,
  OutboxDispatchProjection,
  TimeBlockProjection,
} from './queries/core-queries';
export type {
  SqliteConnection,
  SqliteDriver,
  SqliteMigrationTransaction,
  SqliteParameter,
  SqliteQueryConnection,
  SqliteRunResult,
  SqliteTransaction,
} from './sqlite/driver';
export { checkDatabaseHealth } from './sqlite/health';
export type { DatabaseHealth, ForeignKeyViolation } from './sqlite/health';
export { latestSchemaVersion, schemaMigrations } from './sqlite/migrations';
export {
  checksumMigrationSql,
  defineMigration,
  MigrationError,
  runMigrations,
} from './sqlite/migrations/migration';
export type {
  MigrationErrorCode,
  MigrationResult,
  MigrationSource,
} from './sqlite/migrations/migration';
export { schemaInventory } from './sqlite/schema/inventory';
export { decodeTimeBlockTarget } from './sqlite/schema/records';
export type {
  PlanningPlacementTarget,
  TimeBlockTarget,
  TimeBlockTargetColumns,
  TypedPlanningRelationship,
} from './sqlite/schema/records';
export { actionCaptureOrigins } from './sqlite/schema/vocabulary';
export type { ActionCaptureOrigin } from './sqlite/schema/vocabulary';
export * from './account';

/* optional account synchronization. */
export { SqliteSyncStore } from './sync/sqlite-sync-store';
export type { SqliteSyncStoreOptions } from './sync/sqlite-sync-store';
export { syncSql } from './sync/sync-sql';
export { bindPlanningUnitOfWork } from './application/sqlite-adapters';
export { normalizeSearchText } from './search/search-normalization';
export { SqliteSearchQueries, buildSearchSql } from './search/sqlite-search-queries';
export { SqliteNotificationStore } from './notifications/sqlite-notification-store';
export { SqliteImportStore } from './import/sqlite-import-store';
