/**
 * account and sync UI. The app mounts `AccountProvider` above both the onboarding
 * journey and the app frame, `AccountRoutes` at `/account/*`, `SyncStatusLine` in the frame, and
 * `AccountSettingsSection` on Settings. The Today header and the welcome step use the provider
 * directly; without it they show nothing account-related beyond the honest welcome line.
 */
export {
  AccountProvider,
  accountEmail,
  accountsOffered,
  useAccount,
  useAccountOptional,
  useSyncStatus,
  type AccountContextValue,
  type FirstUploadFlow,
} from './account-context';
export { AccountNoticeBanner } from './account-notice';
export { AccountRoutes } from './account-routes';
export { AccountSettingsSection } from './account-settings';
export { OnboardingSignIn, welcomeAccountText } from './onboarding-sign-in';
export { accountPath, conflictPath, conflictsPath } from './routes';
export { SyncStatusLine, TodaySyncLine } from './sync-status-line';
export type {
  AccountNotice,
  AccountNotices,
  AccountResult,
  AccountService,
  ConflictChoice,
  ConflictDetailView,
  ConflictFieldView,
  ConflictService,
  ConflictSummaryView,
  CountsByKind,
  DeletionPreview,
  ExportFile,
  FirstUploadPreview,
  SignInOutcome,
  SignOutFacts,
  SyncController,
  SyncStateName,
  SyncStatus,
} from './account-service';
