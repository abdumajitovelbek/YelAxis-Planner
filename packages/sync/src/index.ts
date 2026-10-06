/** optional account synchronization: protocol, coordinator, merge, and transport adapters. */
export * from './protocol';
export type {
  AccountResult,
  ConflictChoice,
  ConflictDetailView,
  ConflictFieldView,
  ConflictService,
  ConflictSummaryView,
  SyncController,
  SyncStateName,
  SyncStatus,
} from './controller-contract';
export { createConflictService } from './conflict-service';
export type { ConflictServiceOptions } from './conflict-service';
export { createSyncCoordinator } from './coordinator';
export type {
  SyncCoordinator,
  SyncCoordinatorOptions,
  SyncNetwork,
  SyncScheduler,
  SyncVisibility,
} from './coordinator';
export { createSnapshotHasher, snapshotHashAlgorithm } from './hasher';
export { toPulledPage, toPushOutcome, toPushRequest, toServerConflict } from './protocol-mapping';
export { aggregateSyncStatus } from './status';
export type { SyncStatusInput } from './status';
export {
  createSupabaseSyncTransport,
  syncRequestTimeoutMs,
  syncRpcArgument,
  syncRpcNames,
} from './supabase-transport';
export type {
  SupabaseRpcCall,
  SupabaseRpcClient,
  SupabaseSyncTransportOptions,
} from './supabase-transport';
