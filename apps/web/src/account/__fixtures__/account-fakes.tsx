/**
 * Test-only fakes and fictional data for the account UI. Never imported by runtime code.
 * Every service method rejects unless a test overrides it, so an unexpected call fails loudly.
 */
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi, type Mock, type MockInstance } from 'vitest';

import { AccountProvider } from '../account-context';
import { AccountRoutes } from '../account-routes';
import type {
  AccountNotice,
  AccountNotices,
  AccountResult,
  AccountService,
  ConflictDetailView,
  ConflictService,
  ConflictSummaryView,
  DeletionPreview,
  ExportFile,
  FirstUploadPreview,
  SyncController,
  SyncStatus,
} from '../account-service';

/* ───────────────────────── Results ───────────────────────── */

export const ok = <Value,>(value: Value): AccountResult<Value> => ({ ok: true, value });
export const done: AccountResult = { ok: true, value: undefined };
export const refused = (code: string, message: string): AccountResult<never> => ({
  ok: false,
  code,
  message,
});

/* ───────────────────────── Services ───────────────────────── */

export const accountMethodNames = [
  'signUp',
  'signIn',
  'startFirstUpload',
  'declineFirstUpload',
  'cancelFirstUpload',
  'latestBackup',
  'exportAccount',
  'signOutFacts',
  'signOut',
  'reauthenticate',
  'removeFromDevice',
  'deletionPreview',
  'deleteAccount',
  'retryDeletion',
  'cancelDeletion',
] as const satisfies readonly (keyof AccountService)[];

type MissingAccountMethod = Exclude<
  keyof AccountService,
  (typeof accountMethodNames)[number] | 'configured' | 'localTestService' | 'currentAccount'
>;
/** Compile-time proof that the fake lists every account method. */
export const everyAccountMethodListed: [MissingAccountMethod] extends [never] ? true : false = true;

/**
 * A fake service's method as its mock, read by name so a test never detaches a method from its
 * object (the unbound-method lint rule).
 */
export function mockOf<T extends object>(fake: T, name: keyof T & string): MockInstance {
  const method = (fake as Record<string, unknown>)[name];
  if (!vi.isMockFunction(method)) throw new Error(`${name} is not a mock.`);
  return method;
}

/** Configured, signed out, and every async method rejecting unless overridden. */
export function fakeAccount(overrides: Partial<AccountService> = {}): AccountService {
  const base = Object.fromEntries(
    accountMethodNames.map((name) => [
      name,
      vi.fn(() => Promise.reject(new Error(`Unexpected account call: ${name}`))),
    ]),
  );
  return {
    ...base,
    configured: true,
    localTestService: true,
    currentAccount: vi.fn(() => null),
    ...overrides,
  } as AccountService;
}

export function statusOf(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    state: 'local_only',
    configured: true,
    pendingChanges: 0,
    openConflicts: 0,
    rejectedChanges: 0,
    ...overrides,
  };
}

export interface FakeSync {
  readonly controller: SyncController;
  readonly syncNow: Mock<() => Promise<void>>;
  readonly retryRejected: Mock<() => Promise<void>>;
  /** Change the status and notify subscribers (wrap in `act`). */
  set(next: Partial<SyncStatus>): void;
  /** Replace the whole status (to drop an optional field) and notify subscribers. */
  replace(next: SyncStatus): void;
  readonly listeners: () => number;
}

export function fakeSync(initial: Partial<SyncStatus> = {}): FakeSync {
  let status = statusOf(initial);
  const listeners = new Set<() => void>();
  const syncNow = vi.fn(() => Promise.resolve());
  const retryRejected = vi.fn(() => Promise.resolve());
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const controller: SyncController = {
    // A new object on every call, as a real controller may build one.
    getStatus: () => ({ ...status }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncNow,
    retryRejected,
  };
  return {
    controller,
    syncNow,
    retryRejected,
    set(next) {
      status = { ...status, ...next };
      notify();
    },
    replace(next) {
      status = next;
      notify();
    },
    listeners: () => listeners.size,
  };
}

export interface FakeNotices {
  readonly notices: AccountNotices;
  /** Hold a notice, as the app does when an operation switched the open plan (wrap in `act`). */
  announce(text: string, tone?: AccountNotice['tone']): void;
}

export function fakeNotices(): FakeNotices {
  let notice: AccountNotice | null = null;
  let key = 0;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    notices: {
      current: () => notice,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      consume(consumed) {
        if (notice?.key !== consumed) return;
        notice = null;
        notify();
      },
    },
    announce(text, tone = 'status') {
      key += 1;
      notice = { key, text, tone };
      notify();
    },
  };
}

export function fakeConflicts(overrides: Partial<ConflictService> = {}): ConflictService {
  return {
    list: vi.fn(() => Promise.reject(new Error('Unexpected conflicts call: list'))),
    get: vi.fn(() => Promise.reject(new Error('Unexpected conflicts call: get'))),
    resolve: vi.fn(() => Promise.reject(new Error('Unexpected conflicts call: resolve'))),
    ...overrides,
  };
}

/* ───────────────────────── Trees ───────────────────────── */

export function AccountLocationProbe(): ReactNode {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

export interface AccountTreeOptions {
  readonly path?: string;
  readonly account?: AccountService;
  readonly sync?: FakeSync;
  readonly conflicts?: ConflictService;
  readonly notices?: AccountNotices;
  /** Rendered at `/` instead of the account routes' neighbours. */
  readonly element?: ReactNode;
  /** Rendered above the routes, as the app frame's own parts are. */
  readonly frame?: ReactNode;
  /** Leave the provider out, as a tree the app has not composed yet. */
  readonly withoutProvider?: boolean;
}

/** The account routes at `/account/*` inside the provider, with a location probe. */
export function accountTree(options: AccountTreeOptions = {}): ReactNode {
  const routes = (
    <MemoryRouter initialEntries={[options.path ?? '/account']}>
      {options.frame}
      <Routes>
        <Route path="/account/*" element={<AccountRoutes />} />
        <Route path="/" element={options.element ?? <p>Today page</p>} />
        <Route path="*" element={<p>Another page</p>} />
      </Routes>
      <AccountLocationProbe />
    </MemoryRouter>
  );
  if (options.withoutProvider === true) return routes;
  return (
    <AccountProvider
      account={options.account ?? fakeAccount()}
      sync={(options.sync ?? fakeSync()).controller}
      conflicts={options.conflicts ?? fakeConflicts()}
      {...(options.notices === undefined ? {} : { notices: options.notices })}
    >
      {routes}
    </AccountProvider>
  );
}

/* ───────────────────────── Browser stubs ───────────────────────── */

export interface DownloadStubs {
  readonly createObjectURL: Mock<(blob: Blob) => string>;
  readonly revokeObjectURL: Mock<(url: string) => void>;
  /** Every programmatic download link click: its URL and file name. */
  readonly clicks: { readonly href: string; readonly download: string }[];
}

/** jsdom has no object URLs and cannot navigate: record both instead. */
export function installDownloadStubs(): DownloadStubs {
  let count = 0;
  const createObjectURL = vi.fn((blob: Blob) => {
    void blob;
    count += 1;
    return `blob:yelaxis-test/${String(count)}`;
  });
  const revokeObjectURL = vi.fn((url: string) => {
    void url;
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  });
  const clicks: { href: string; download: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: unknown) {
    const link = this as HTMLAnchorElement;
    clicks.push({ href: link.getAttribute('href') ?? '', download: link.download });
  });
  return { createObjectURL, revokeObjectURL, clicks };
}

/** Set the browser's online flag and tell listeners. */
export function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

/* ───────────────────────── Fictional data ───────────────────────── */

export const testEmail = 'sam@example.test';
export const testPassword = 'correct horse battery staple';

export function uploadPreview(overrides: Partial<FirstUploadPreview> = {}): FirstUploadPreview {
  return {
    accountEmail: testEmail,
    local: {
      kinds: [
        { label: 'Actions', count: 12 },
        { label: 'Outcomes', count: 2 },
        { label: 'Routines', count: 1 },
      ],
      total: 15,
    },
    cloudRecordCount: 0,
    sensitiveContextCount: 0,
    ...overrides,
  };
}

export function exportFile(overrides: Partial<ExportFile> = {}): ExportFile {
  return {
    fileName: 'yelaxis-account-2026-10-01.json',
    blob: new Blob(['{"format":"yelaxis"}'], { type: 'application/json' }),
    recordCount: 15,
    syncWasPending: false,
    ...overrides,
  };
}

export function deletionPreview(overrides: Partial<DeletionPreview> = {}): DeletionPreview {
  return {
    accountEmail: testEmail,
    cloud: {
      kinds: [
        { label: 'Actions', count: 40 },
        { label: 'Reviews', count: 2 },
      ],
      total: 42,
    },
    local: { kinds: [{ label: 'Actions', count: 41 }], total: 41 },
    pendingChanges: 0,
    ...overrides,
  };
}

export const conflictId = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

export function conflictSummary(overrides: Partial<ConflictSummaryView> = {}): ConflictSummaryView {
  return {
    conflictId: conflictId(1),
    kindLabel: 'Action',
    title: 'Draft the outline',
    kind: 'stale_base',
    createdAt: '2026-10-01T09:30:00.000Z',
    ...overrides,
  };
}

export function conflictDetail(overrides: Partial<ConflictDetailView> = {}): ConflictDetailView {
  return {
    ...conflictSummary(),
    fields: [
      {
        field: 'title',
        label: 'Title',
        base: 'Draft outline',
        local: 'Draft the outline',
        remote: 'Outline the draft',
      },
      { field: 'due', label: 'Due date', base: 'Oct 2, 2026', local: 'Oct 3, 2026' },
    ],
    choices: ['keep_local', 'keep_remote', 'merge'],
    ...overrides,
  };
}
