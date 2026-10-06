import { message as uiMessage } from './messages';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStoredPreference } from './stored-preference';
import {
  BrowserRouter,
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';

import {
  browserClock,
  browserIdProvider,
  createActionApplication,
  createAlignmentApplication,
  createOnboardingApplication,
  createPlanningApplication,
  createReviewApplication,
  createSerialQueue,
  createTodayApplication,
  createSearchApplication,
  createExportApplication,
  createImportApplication,
  createNotificationApplication,
  type ActionApplication,
  type AlignmentApplication,
  type OnboardingApplication,
  type OnboardingState,
  type PlanningApplication,
  type ReviewApplication,
  type TodayApplication,
  type SearchApplication,
  type ExportApplication,
  type ImportApplication,
  type NotificationApplication,
} from '@yelaxis/application';
import {
  createSqliteApplicationAdapters,
  SqliteActionPlanningQueries,
  SqliteAlignmentQueries,
  SqliteOnboardingPersistence,
  SqlitePlanningQueries,
  SqliteReviewQueries,
  SqliteTodayQueries,
  SqliteSearchQueries,
  SqliteImportStore,
  SqliteNotificationStore,
  CanonicalBundleCodec,
} from '@yelaxis/data';

import {
  AccountNoticeBanner,
  AccountProvider,
  AccountRoutes,
  AccountSettingsSection,
  SyncStatusLine,
} from './account';
import { detectDeviceDefaults } from './device-defaults';
import { Handbook, OnboardingJourney } from './onboarding-ui';
import { ActionDetailPage, GlobalCapture, InboxPage } from './actions-ui';
import { alignmentRoutes } from './alignment/alignment-routes';
import { NavigationNotice } from './alignment/kit';
import {
  bundleAppVersion,
  createIdentityRuntime,
  type IdentityRuntime,
} from './identity/identity-runtime';
import type { IdentityStore } from './identity/identity-stores';
import { createStoreSync, lazySyncTransport, SyncSwitch } from './identity/store-sync';
import {
  createSyncedAccountService,
  type SyncedAccountService,
} from './identity/synced-account-service';
import { PlanRoutes } from './plan/plan-shell';
import { notifyPlanChanged, PlanningProvider } from './plan/planning-context';
import { isAxisAreaPath, isReviewAreaPath, isTodayAreaPath } from './plan/routes';
import { ZoneChangeNotice } from './plan/zone-change';
import { registerPwaUpdates, type PwaUpdateController } from './pwa';
import { ReviewOverviewPage } from './review/review-overview';
import { ReviewPeriodPage, ReviewUnavailable } from './review/review-page';
import { EndDayPage } from './today/end-day';
import { FocusPage } from './today/focus-mode';
import { TodayRoute } from './today/today-page';
import { SearchPage } from './search/search-page';
import { SearchDetailPage } from './search/search-detail';
import { DataPage } from './data/data-page';
import { ImportRecoveryNotice } from './data/recovery-notice';
import { BrowserNotifications } from './notifications/browser-notifications';
import { NotificationProvider } from './notifications/notification-context';
import { NotificationsPage, NotificationSettings } from './notifications/notifications-page';
import { DiagnosticsPanel } from './release/diagnostics-panel';

type ReadyState = Readonly<{
  status: 'ready';
  /** The active planning identity's open store (account sync: one database per identity). */
  store: IdentityStore;
  onboarding: OnboardingApplication;
  actions: ActionApplication;
  planning: PlanningApplication;
  alignment: AlignmentApplication;
  today: TodayApplication;
  /** Reviews Reviews. */
  reviews: ReviewApplication;
  search: SearchApplication;
  exports: ExportApplication;
  imports: ImportApplication;
  notifications: NotificationApplication;
  onboardingState: OnboardingState;
}>;
type AppState =
  | { readonly status: 'loading' }
  | ReadyState
  /** An account's replica waits for its profile to arrive from the account. */
  | { readonly status: 'account_opening'; readonly store: IdentityStore }
  | { readonly status: 'error'; readonly message: string };
type ThemePreference = 'dark' | 'light' | 'system';
type MotionPreference = 'full' | 'reduced' | 'system';

const navigation: readonly {
  readonly to: string;
  readonly label: string;
  readonly end?: boolean;
  /**
   * Current for more than its own path: Today includes Focus mode and End Day; the Axis area
   * includes Outcome, Project, and Milestone pages; Review includes every review page.
   */
  readonly isCurrent?: (pathname: string) => boolean;
}[] = [
  { to: '/', label: uiMessage('app.782'), isCurrent: isTodayAreaPath },
  { to: '/plan', label: uiMessage('actions-ui.250') },
  { to: '/axis', label: uiMessage('actions-ui.251'), isCurrent: isAxisAreaPath },
  { to: '/review', label: uiMessage('app.783'), isCurrent: isReviewAreaPath },
];
const utilityNavigation = [
  { to: '/inbox', label: uiMessage('actions-ui.230') },
  { to: '/search', label: uiMessage('app.784') },
  { to: '/notifications', label: uiMessage('app.785') },
  { to: '/learn', label: uiMessage('app.786') },
  { to: '/settings', label: uiMessage('app.787') },
] as const;

export function App(): ReactNode {
  return (
    <BrowserRouter>
      <AppRuntime />
    </BrowserRouter>
  );
}

function AppRuntime(): ReactNode {
  useEffect(() => {
    const updateVisibility = (): void => {
      document.documentElement.dataset['appVisibility'] = document.visibilityState;
    };
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);
  // account sync: identities, their stores, and the account service. One runtime per app.
  const runtime = useRef<IdentityRuntime | null>(null);
  runtime.current ??= createIdentityRuntime();
  const identity = runtime.current;
  // account sync: one SyncController and ConflictService for the app; it follows the active store, whose
  // coordinator runs only for an account identity.
  const syncSwitch = useRef<SyncSwitch | null>(null);
  syncSwitch.current ??= new SyncSwitch(identity.account.configured);
  const sync = syncSwitch.current;
  // It outlives every store switch, so it holds the outcome of an operation whose switch replaced
  // the view that started it.
  const accountService = useRef<SyncedAccountService | null>(null);
  accountService.current ??= createSyncedAccountService(identity.account, sync, identity.stores);
  const account = accountService.current;
  /** Each connection attempt; a store switch or a newer attempt makes older ones stale. */
  const generation = useRef(0);
  const mounted = useRef(true);
  const activeNotifications = useRef<NotificationApplication | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<AppState>({ status: 'loading' });
  const [online, setOnline] = useState(navigator.onLine);
  const [update, setUpdate] = useState<PwaUpdateController | null>(null);
  const [deferred, setDeferred] = useState(false);
  const [theme, setTheme] = useStoredPreference<ThemePreference>(
    'yelaxis:appearance:theme',
    'system',
    ['system', 'light', 'dark'],
  );
  const [motion, setMotion] = useStoredPreference<MotionPreference>(
    'yelaxis:appearance:motion',
    'system',
    ['system', 'full', 'reduced'],
  );

  const connect = async (): Promise<void> => {
    activeNotifications.current?.stop();
    activeNotifications.current = null;
    generation.current += 1;
    const attempt = generation.current;
    const current = (): boolean => mounted.current && attempt === generation.current;
    setState({ status: 'loading' });
    try {
      // The active identity's store: its own database, Web Lock, and serialized connection queue,
      // shared by every service below and by the account service.
      const store = await identity.ready();
      if (!current()) return;
      const driver = store.opened.driver;
      // Every facade below, and the sync application, share one command queue: a capture submitted
      // while a planning or sync transaction is pending waits instead of failing as busy.
      const queue = createSerialQueue();
      // An account's replica syncs from the moment it opens, so its plan can arrive .
      // The coordinator stops on the next store switch, before this store closes. A coordinator
      // that worked on this same store (a link or a cancel reopens it) finishes its running cycle
      // before the new one attaches, so two never sync one store at once.
      await sync.detach();
      if (!current()) return;
      const accountClient = identity.accountClient;
      if (store.identity.kind === 'account' && accountClient !== null) {
        sync.attach(
          createStoreSync({
            driver,
            queue,
            transport: lazySyncTransport(accountClient),
            account: () => identity.account.currentAccount(),
            // A first upload is linked once its groups are acknowledged and a pull checkpoint
            // exists; the identity part checks both.
            afterCycle: async (facts, coordinator) => {
              if (facts.link !== 'linking') return;
              if (await identity.account.completeLinkIfReady()) await coordinator.refresh();
            },
            onPlanChanged: notifyPlanChanged,
          }),
        );
        // The first facts are read before anything renders, so an account plan never shows as
        // local only while its coordinator starts.
        await sync.refresh();
        if (!current()) return;
      }
      const localChange = (): void => sync.coordinator?.notifyLocalChange();
      const onboarding = notifyingOnboarding(
        createOnboardingApplication(new SqliteOnboardingPersistence(driver), {
          clock: browserClock(),
          ids: browserIdProvider(),
        }),
        localChange,
      );
      // An account's replica receives its profile from the account; it is never invented here.
      const onboardingState =
        (await onboarding.load()) ??
        (store.identity.kind === 'local'
          ? await onboarding.initialize(detectDeviceDefaults())
          : null);
      if (!current()) return;
      if (onboardingState === null) {
        setState({ status: 'account_opening', store });
        return;
      }
      const dependencies = {
        ...createSqliteApplicationAdapters(driver),
        clock: browserClock(),
        ids: browserIdProvider(),
        // A committed command on an account plan syncs after a short debounce.
        projections: { notifyCommitted: localChange },
      };
      const actions = createActionApplication(
        dependencies,
        new SqliteActionPlanningQueries(driver),
        { queue },
      );
      const planning = createPlanningApplication(dependencies, new SqlitePlanningQueries(driver), {
        queue,
      });
      // Alignment shares the same queue, so an impact preview and its command never interleave
      // with another facade's transaction.
      const alignment = createAlignmentApplication(
        dependencies,
        new SqliteAlignmentQueries(driver),
        { queue },
      );
      // Today reads and commands share the same queue as every other facade.
      const today = createTodayApplication(dependencies, new SqliteTodayQueries(driver), {
        queue,
      });
      // Reviews Reviews read and command on the same queue as every other facade.
      const reviews = createReviewApplication(dependencies, new SqliteReviewQueries(driver), {
        queue,
      });
      const search = createSearchApplication(
        dependencies.identityContext,
        new SqliteSearchQueries(driver),
        { queue },
      );
      const codec = new CanonicalBundleCodec();
      const exports = createExportApplication(
        {
          accounts: store.accounts,
          decoder: codec,
          bundles: codec,
          ownerId: store.identity.id,
          clock: dependencies.clock,
          ids: dependencies.ids,
          appVersion: bundleAppVersion,
        },
        { queue },
      );
      const imports = createImportApplication(
        {
          store: new SqliteImportStore(driver),
          decoder: codec,
          bundles: codec,
          clock: dependencies.clock,
          ids: dependencies.ids,
          projections: {
            notifyCommitted: () => {
              localChange();
              notifyPlanChanged();
            },
          },
          appVersion: bundleAppVersion,
        },
        { queue },
      );
      const notifications = createNotificationApplication({
        store: new SqliteNotificationStore(driver),
        notifications: new BrowserNotifications(),
        identity: dependencies.identityContext,
        clock: dependencies.clock,
        queue,
        navigate: (href) => {
          void navigate(href);
        },
      });
      activeNotifications.current = notifications;
      setState({
        status: 'ready',
        store,
        onboarding,
        actions,
        planning,
        alignment,
        today,
        reviews,
        search,
        exports,
        imports,
        notifications,
        onboardingState,
      });
    } catch (error) {
      if (!current()) return;
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : uiMessage('app.790'),
      });
    }
  };

  useEffect(() => {
    mounted.current = true;
    // A store switch (sign-in, sign-out, linking, cancel, detach) stops this store's sync
    // coordinator before the store closes, then rebuilds every service on the new store.
    const unsubscribe = identity.stores.subscribe((event) => {
      if (event.type === 'switching') {
        activeNotifications.current?.stop();
        activeNotifications.current = null;
        // Stops at once; `connect` waits for a running cycle to end before attaching again.
        void sync.detach();
        generation.current += 1;
        setState({ status: 'loading' });
        return;
      }
      void connect();
    });
    void connect();
    return () => {
      mounted.current = false;
      activeNotifications.current?.stop();
      activeNotifications.current = null;
      unsubscribe();
      void sync.detach();
      void identity.close();
    };
  }, []);
  useEffect(() => {
    const handleOnline = (): void => setOnline(true);
    const handleOffline = (): void => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    registerPwaUpdates(setUpdate);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset['theme'] = resolveTheme(theme);
    document.documentElement.dataset['motion'] = resolveMotion(motion);
  }, [motion, theme]);

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') return <StorageError message={state.message} retry={connect} />;
  if (state.status === 'account_opening') {
    return (
      <AccountOpening
        store={state.store}
        onArrived={connect}
        returnToLocal={async () => {
          const result = await account.signOut();
          return result.ok ? null : result.message;
        }}
      />
    );
  }

  const updateOnboarding = (onboardingState: OnboardingState): void => {
    setState({ ...state, onboardingState });
    if (onboardingState.status === 'completed' && location.pathname === '/onboarding')
      void navigate('/');
  };
  // The onboarding journey and the app frame mount the account services at the same tree position,
  // so a first-upload choice made on the welcome step survives into the frame.
  const withAccount = (children: ReactNode): ReactNode => (
    <AccountProvider account={account} sync={sync} conflicts={sync} notices={account.notices}>
      <NotificationProvider application={state.notifications}>{children}</NotificationProvider>
    </AccountProvider>
  );
  const showOnboarding = state.onboardingState.status !== 'completed' && !deferred;
  if (showOnboarding) {
    // A fresh local plan (after deleting an account with this device's copy) starts at setup: the
    // outcome is said above it.
    return withAccount(
      <>
        <AccountNoticeBanner accountPageMounted={false} />
        <OnboardingJourney
          application={state.onboarding}
          online={online}
          state={state.onboardingState}
          updateState={updateOnboarding}
          onLeave={() => {
            setDeferred(true);
            void navigate('/');
          }}
        />
      </>,
    );
  }

  return withAccount(
    <PlanningProvider
      planning={state.planning}
      actions={state.actions}
      alignment={state.alignment}
      today={state.today}
      reviews={state.reviews}
    >
      <div className="app-frame">
        <a className="skip-link" href="#main-content">
          {uiMessage('app.791')}
        </a>
        <aside className="sidebar" aria-label={uiMessage('alignment.outcome-detail.726')}>
          <Brand />
          <nav className="primary-nav">
            {navigation.map((item) => (
              <NavItem key={item.to} {...item} />
            ))}
          </nav>
          <nav className="utility-nav" aria-label={uiMessage('app.792')}>
            {utilityNavigation.map((item) => (
              <NavItem key={item.to} {...item} />
            ))}
          </nav>
          <p className="storage-summary">
            <span className="status-dot" aria-hidden="true" />
            {uiMessage('app.793')}
            {state.store.opened.durability}
          </p>
          <SyncStatusLine />
        </aside>
        <div className="workspace">
          {!online && (
            <div className="offline-banner" role="status">
              {uiMessage('app.794')}
            </div>
          )}
          {state.onboardingState.status !== 'completed' && (
            <div className="setup-banner" role="status">
              <span>{uiMessage('app.795')}</span>
              <button
                type="button"
                onClick={() => {
                  setDeferred(false);
                  void navigate('/onboarding');
                }}
              >
                {uiMessage('app.796')}
              </button>
            </div>
          )}
          <header className="topbar">
            <p>{uiMessage('app.797')}</p>
            <div className="topbar-actions">
              <GlobalCapture application={state.actions} />
              <Link className="text-link" to="/settings">
                {uiMessage('app.787')}
              </Link>
            </div>
          </header>
          <ZoneChangeNotice />
          <ImportRecoveryNotice application={state.imports} />
          <main id="main-content" className="main-content" tabIndex={-1}>
            <RouteFocus />
            <AccountNoticeBanner />
            <NavigationNotice />
            <Routes>
              <Route
                path="/"
                element={
                  <TodayRoute
                    preferredName={state.onboardingState.today.preferredName}
                    defaultsConfirmed={state.onboardingState.defaultsConfirmedAt !== undefined}
                    onResumeSetup={() => {
                      setDeferred(false);
                      void navigate('/onboarding');
                    }}
                  />
                }
              />
              <Route path="/focus/:actionId" element={<FocusPage />} />
              <Route path="/end-day/:date" element={<EndDayPage />} />
              <Route path="/plan/*" element={<PlanRoutes />} />
              {alignmentRoutes()}
              <Route path="/review" element={<ReviewOverviewPage />} />
              <Route path="/review/:type/:key" element={<ReviewPeriodPage />} />
              <Route path="/review/*" element={<ReviewUnavailable />} />
              <Route path="/inbox" element={<InboxPage application={state.actions} />} />
              <Route
                path="/actions/:actionId"
                element={<ActionDetailPage application={state.actions} />}
              />
              <Route path="/search" element={<SearchPage application={state.search} />} />
              <Route
                path="/learn"
                element={
                  <LearnPage
                    application={state.onboarding}
                    state={state.onboardingState}
                    updateState={updateOnboarding}
                  />
                }
              />
              <Route
                path="/settings"
                element={
                  <SettingsPage
                    application={state.onboarding}
                    motion={motion}
                    setMotion={setMotion}
                    setTheme={setTheme}
                    state={state.onboardingState}
                    theme={theme}
                    updateState={updateOnboarding}
                    openOnboarding={() => {
                      setDeferred(false);
                      void navigate('/onboarding');
                    }}
                  />
                }
              />
              <Route
                path="/onboarding"
                element={<OnboardingRedirect state={state.onboardingState} />}
              />
              <Route path="/account/*" element={<AccountRoutes />} />
              <Route
                path="/search/:kind/:id"
                element={<SearchDetailPage application={state.search} />}
              />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route
                path="/data"
                element={
                  <DataPage
                    exports={state.exports}
                    imports={state.imports}
                    planning={state.planning}
                    durability={state.store.opened.durability}
                    onImported={() => {
                      void state.onboarding.load().then((loaded) => {
                        if (loaded !== null) updateOnboarding(loaded);
                      });
                    }}
                  />
                }
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>
        </div>
        {update !== null && (
          <UpdateDialog
            controller={update}
            onDismiss={() => {
              update.dismiss();
              setUpdate(null);
            }}
          />
        )}
      </div>
    </PlanningProvider>,
  );
}

/** Setup commits on an account plan sync like every other command. */
function notifyingOnboarding(
  application: OnboardingApplication,
  committed: () => void,
): OnboardingApplication {
  return {
    initialize: (defaults) => application.initialize(defaults),
    load: () => application.load(),
    async execute(command) {
      const result = await application.execute(command);
      if (result.ok) committed();
      return result;
    },
  };
}

function LearnPage({
  application,
  state,
  updateState,
}: {
  readonly application: OnboardingApplication;
  readonly state: OnboardingState;
  readonly updateState: (state: OnboardingState) => void;
}): ReactNode {
  const heading = useRef<HTMLHeadingElement>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    operation: () => ReturnType<OnboardingApplication['execute']>,
  ): Promise<boolean> => {
    const result = await operation();
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    updateState(result.value);
    return true;
  };
  if (state.handbook.status !== 'in_progress')
    return (
      <section className="content-section" aria-labelledby="page-title">
        <p className="eyebrow">{uiMessage('app.786')}</p>
        <h1 id="page-title">{uiMessage('app.798')}</h1>
        <p className="page-message">{uiMessage('app.799')}</p>
        <p className="status-pill">
          {uiMessage('app.800')}
          {state.handbook.status.replace('_', ' ')}
        </p>
        {error !== null && <p role="alert">{error}</p>}
        <button
          className="primary-button"
          type="button"
          onClick={() =>
            void run(() => application.execute({ kind: 'reset_handbook' })).then(
              (ok) =>
                ok &&
                run(() =>
                  application.execute({
                    kind: 'save_handbook',
                    status: 'in_progress',
                    lesson: 0,
                    completedLessons: [],
                  }),
                ),
            )
          }
        >
          {state.handbook.status === 'not_started' ? uiMessage('app.801') : uiMessage('app.802')}
        </button>
      </section>
    );
  return (
    <section className="content-section" aria-labelledby="onboarding-title">
      {error !== null && <p role="alert">{error}</p>}
      <Handbook
        application={application}
        busy={false}
        heading={heading}
        mode="standalone"
        onRun={run}
        state={state}
      />
    </section>
  );
}

function SettingsPage({
  application,
  motion,
  openOnboarding,
  setMotion,
  setTheme,
  state,
  theme,
  updateState,
}: {
  readonly application: OnboardingApplication;
  readonly motion: MotionPreference;
  readonly openOnboarding: () => void;
  readonly setMotion: (value: MotionPreference) => void;
  readonly setTheme: (value: ThemePreference) => void;
  readonly state: OnboardingState;
  readonly theme: ThemePreference;
  readonly updateState: (state: OnboardingState) => void;
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const execute = async (kind: 'rerun' | 'reset_onboarding'): Promise<void> => {
    const result = await application.execute({ kind });
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    updateState(result.value);
    dialog.current?.close();
    openOnboarding();
  };
  return (
    <section className="content-section settings" aria-labelledby="page-title">
      <p className="eyebrow">{uiMessage('app.787')}</p>
      <h1 id="page-title">{uiMessage('app.803')}</h1>
      <p className="page-message">{uiMessage('app.804')}</p>
      {message !== null && <p role="alert">{message}</p>}
      <section className="settings-section">
        <div>
          <h2>{uiMessage('app.805')}</h2>
          <p>
            {state.draft.defaults?.planningTimeZone} · {state.draft.defaults?.weekStart}
            {uiMessage('app.806')}{' '}
            {state.draft.defaults?.timeFormat === '12_hour'
              ? uiMessage('app.2448')
              : uiMessage('app.2449')}
          </p>
        </div>
        <button type="button" onClick={() => void execute('rerun')}>
          {uiMessage('app.807')}
        </button>
      </section>
      <section className="settings-section">
        <div>
          <h2>{uiMessage('app.808')}</h2>
          <p>{uiMessage('app.809')}</p>
        </div>
        <button type="button" onClick={() => dialog.current?.showModal()}>
          {uiMessage('app.810')}
        </button>
      </section>
      <AccountSettingsSection />
      <section className="settings-section">
        <div>
          <h2>{uiMessage('app.811')}</h2>
          <p>{uiMessage('app.812')}</p>
        </div>
        <Link className="inline-button" to="/data">
          {uiMessage('app.813')}
        </Link>
      </section>
      <NotificationSettings />
      <DiagnosticsPanel />
      <PreferenceGroup
        legend={uiMessage('review.saved-review.2009')}
        name="theme"
        options={[
          ['system', uiMessage('app.814')],
          ['light', uiMessage('app.815')],
          ['dark', uiMessage('app.816')],
        ]}
        selected={theme}
        setSelected={(value) => setTheme(value as ThemePreference)}
      />
      <PreferenceGroup
        legend={uiMessage('app.2406')}
        name="motion"
        options={[
          ['system', uiMessage('app.817')],
          ['reduced', uiMessage('app.818')],
          ['full', uiMessage('app.819')],
        ]}
        selected={motion}
        setSelected={(value) => setMotion(value as MotionPreference)}
      />
      <dialog
        className="update-dialog"
        ref={dialog}
        aria-labelledby="reset-title"
        onClose={() => setMessage(null)}
      >
        <p className="eyebrow">{uiMessage('app.820')}</p>
        <h2 id="reset-title">{uiMessage('app.821')}</h2>
        <p>{uiMessage('app.822')}</p>
        <div className="dialog-actions">
          <button type="button" onClick={() => dialog.current?.close()}>
            {uiMessage('account.account-dialogs.20')}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => void execute('reset_onboarding')}
          >
            {uiMessage('app.810')}
          </button>
        </div>
      </dialog>
    </section>
  );
}

function OnboardingRedirect({ state }: { readonly state: OnboardingState }): ReactNode {
  return (
    <section className="content-section">
      <p className="eyebrow">{uiMessage('app.823')}</p>
      <h1>{state.status === 'completed' ? uiMessage('app.824') : uiMessage('app.825')}</h1>
    </section>
  );
}

function Brand(): ReactNode {
  return (
    <Link className="brand" to="/" aria-label={uiMessage('app.826')}>
      <span className="brand-mark" aria-hidden="true">
        {uiMessage('app.827')}
      </span>
      <span>{uiMessage('app.828')}</span>
    </Link>
  );
}
function NavItem({
  end,
  isCurrent,
  label,
  to,
}: {
  readonly end?: boolean;
  readonly isCurrent?: (pathname: string) => boolean;
  readonly label: string;
  readonly to: string;
}): ReactNode {
  const { pathname } = useLocation();
  if (isCurrent !== undefined) {
    const current = isCurrent(pathname);
    return (
      <Link
        className={current ? 'nav-link active' : 'nav-link'}
        to={to}
        aria-current={current ? 'page' : undefined}
      >
        {label}
      </Link>
    );
  }
  return (
    <NavLink className="nav-link" {...(end === undefined ? {} : { end })} to={to}>
      {label}
    </NavLink>
  );
}
function Loading(): ReactNode {
  return (
    <main className="centered-state" aria-busy="true" aria-live="polite">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          {uiMessage('app.827')}
        </span>
        <span>{uiMessage('app.828')}</span>
      </div>
      <div className="spinner" aria-hidden="true" />
      <h1>{uiMessage('app.829')}</h1>
      <p>{uiMessage('app.830')}</p>
    </main>
  );
}
/**
 * An account's replica before its first pull brings the profile. Nothing is
 * invented locally; the plan appears as soon as it arrives, and the local plan stays one step away.
 */
function AccountOpening({
  onArrived,
  returnToLocal,
  store,
}: {
  readonly onArrived: () => Promise<void>;
  readonly returnToLocal: () => Promise<string | null>;
  readonly store: IdentityStore;
}): ReactNode {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const onboarding = createOnboardingApplication(
      new SqliteOnboardingPersistence(store.opened.driver),
      { clock: browserClock(), ids: browserIdProvider() },
    );
    const timer = window.setInterval(() => {
      onboarding.load().then(
        (loaded) => {
          if (active && loaded !== null) void onArrived();
        },
        () => undefined,
      );
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [store]);
  return (
    <main className="centered-state" aria-busy={busy} aria-live="polite">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          {uiMessage('app.827')}
        </span>
        <span>{uiMessage('app.828')}</span>
      </div>
      <p className="eyebrow">{uiMessage('account.account-page.76')}</p>
      <h1>{uiMessage('app.831')}</h1>
      <p>{uiMessage('app.832')}</p>
      <p className="supporting">{uiMessage('app.833')}</p>
      {message !== null && <p role="alert">{message}</p>}
      <button
        disabled={busy}
        type="button"
        onClick={() => {
          setBusy(true);
          void returnToLocal().then((failure) => {
            setBusy(false);
            setMessage(failure);
          });
        }}
      >
        {uiMessage('app.834')}
      </button>
    </main>
  );
}

function StorageError({
  message,
  retry,
}: {
  readonly message: string;
  readonly retry: () => Promise<void>;
}): ReactNode {
  return (
    <main className="centered-state" role="alert">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          {uiMessage('app.827')}
        </span>
        <span>{uiMessage('app.828')}</span>
      </div>
      <p className="eyebrow">{uiMessage('app.835')}</p>
      <h1>{uiMessage('app.836')}</h1>
      <p>{message}</p>
      <p className="supporting">{uiMessage('app.837')}</p>
      <button className="primary-button" type="button" onClick={() => void retry()}>
        {uiMessage('account.account-dialogs.47')}
      </button>
    </main>
  );
}

function PreferenceGroup({
  legend,
  name,
  options,
  selected,
  setSelected,
}: {
  readonly legend: string;
  readonly name: string;
  readonly options: readonly (readonly [string, string])[];
  readonly selected: string;
  readonly setSelected: (value: string) => void;
}): ReactNode {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <div className="option-grid">
        {options.map(([value, label]) => (
          <label className="radio-option" key={value}>
            <input
              checked={selected === value}
              name={name}
              onChange={() => setSelected(value)}
              type="radio"
              value={value}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
function UpdateDialog({
  controller,
  onDismiss,
}: {
  readonly controller: PwaUpdateController;
  readonly onDismiss: () => void;
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current?.showModal(), []);
  return (
    <dialog
      aria-labelledby="update-title"
      className="update-dialog"
      onCancel={onDismiss}
      ref={dialog}
    >
      <p className="eyebrow">{uiMessage('app.838')}</p>
      <h2 id="update-title">{uiMessage('app.839')}</h2>
      <p>{uiMessage('app.840')}</p>
      <div className="dialog-actions">
        <button type="button" onClick={onDismiss}>
          {uiMessage('app.841')}
        </button>
        <button className="primary-button" type="button" onClick={() => void controller.activate()}>
          {uiMessage('app.842')}
        </button>
      </div>
    </dialog>
  );
}
function NotFound(): ReactNode {
  return (
    <section className="content-section" aria-labelledby="page-title">
      <p className="eyebrow">{uiMessage('app.843')}</p>
      <h1 id="page-title">{uiMessage('account.account-routes.109')}</h1>
      <p className="page-message">{uiMessage('app.844')}</p>
      <Link className="primary-button inline-button" to="/">
        {uiMessage('app.845')}
      </Link>
    </section>
  );
}
function RouteFocus(): null {
  const { pathname } = useLocation();
  const initialPath = useRef(pathname);
  useEffect(() => {
    if (pathname === initialPath.current) return;
    initialPath.current = pathname;
    document.querySelector<HTMLElement>('#main-content')?.focus();
  }, [pathname]);
  return null;
}

function resolveTheme(preference: ThemePreference): 'dark' | 'light' {
  return preference === 'system'
    ? window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark'
    : preference;
}
function resolveMotion(preference: MotionPreference): 'full' | 'reduced' {
  return preference === 'system'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'reduced'
      : 'full'
    : preference;
}
