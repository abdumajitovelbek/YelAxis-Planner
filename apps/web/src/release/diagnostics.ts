/** Support files are opt-in and contain only this closed metadata allowlist. */
export interface DiagnosticReport {
  readonly schemaVersion: 1;
  readonly releaseChannel: 'beta';
  readonly revision: string | null;
  readonly browserFamily: 'chromium' | 'firefox' | 'other';
  readonly online: boolean | null;
  readonly secureContext: boolean | null;
  readonly capabilities: Readonly<{
    indexedDb: boolean;
    webLocks: boolean;
    dedicatedWorker: boolean;
    serviceWorker: boolean;
    notifications: boolean;
  }>;
  readonly notificationPermission: 'unsupported' | 'default' | 'granted' | 'denied';
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Never serialize the input, navigator, a caught error, plan, route, storage, or account. */
export function createDiagnosticReport(input: Readonly<Record<string, unknown>>): DiagnosticReport {
  const permission = input['notificationPermission'];
  const family = input['browserFamily'];
  const revision = input['revision'];
  return {
    schemaVersion: 1,
    releaseChannel: 'beta',
    revision: typeof revision === 'string' && /^[a-f0-9]{7,40}$/u.test(revision) ? revision : null,
    browserFamily: family === 'chromium' || family === 'firefox' ? family : 'other',
    online: booleanOrNull(input['online']),
    secureContext: booleanOrNull(input['secureContext']),
    capabilities: {
      indexedDb: input['indexedDb'] === true,
      webLocks: input['webLocks'] === true,
      dedicatedWorker: input['dedicatedWorker'] === true,
      serviceWorker: input['serviceWorker'] === true,
      notifications: input['notifications'] === true,
    },
    notificationPermission:
      permission === 'default' || permission === 'granted' || permission === 'denied'
        ? permission
        : 'unsupported',
  };
}

export function inspectDiagnosticCapabilities(): DiagnosticReport {
  const userAgent = navigator.userAgent;
  return createDiagnosticReport({
    revision: import.meta.env['VITE_YELAXIS_RELEASE_REVISION'],
    browserFamily: /Firefox\//u.test(userAgent)
      ? 'firefox'
      : /(?:Chrome|Chromium)\//u.test(userAgent)
        ? 'chromium'
        : 'other',
    online: navigator.onLine,
    secureContext: window.isSecureContext,
    indexedDb: typeof indexedDB !== 'undefined',
    webLocks: typeof navigator.locks !== 'undefined',
    dedicatedWorker: typeof Worker !== 'undefined',
    serviceWorker: 'serviceWorker' in navigator,
    notifications: typeof Notification !== 'undefined',
    notificationPermission:
      typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  });
}
