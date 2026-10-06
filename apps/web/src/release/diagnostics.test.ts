import { describe, expect, it } from 'vitest';

import { createDiagnosticReport } from './diagnostics';

describe('closed support metadata boundary', () => {
  it('omits arbitrary private content, URLs, identifiers, tokens and raw errors', () => {
    const report = createDiagnosticReport({
      revision: '975824c',
      browserFamily: 'chromium',
      online: false,
      secureContext: true,
      indexedDb: true,
      webLocks: true,
      dedicatedWorker: true,
      serviceWorker: true,
      notifications: true,
      notificationPermission: 'denied',
      title: 'synthetic-private-plan',
      account: 'synthetic-private-account',
      token: 'synthetic-private-token',
      href: '/actions/synthetic-private-id',
      error: { message: 'synthetic-private-error' },
    });
    expect(JSON.stringify(report)).not.toContain('synthetic-private');
    expect(report).toEqual({
      schemaVersion: 1,
      releaseChannel: 'beta',
      revision: '975824c',
      browserFamily: 'chromium',
      online: false,
      secureContext: true,
      capabilities: {
        indexedDb: true,
        webLocks: true,
        dedicatedWorker: true,
        serviceWorker: true,
        notifications: true,
      },
      notificationPermission: 'denied',
    });
  });
  it('refuses private text smuggled through allowed enum/revision/boolean fields', () => {
    const report = createDiagnosticReport({
      revision: 'synthetic-private',
      browserFamily: 'synthetic-private',
      online: 'synthetic-private',
      notificationPermission: 'synthetic-private',
      indexedDb: 'synthetic-private',
    });
    expect(JSON.stringify(report)).not.toContain('synthetic-private');
    expect(report.revision).toBeNull();
    expect(report.online).toBeNull();
    expect(report.browserFamily).toBe('other');
    expect(report.notificationPermission).toBe('unsupported');
    expect(report.capabilities.indexedDb).toBe(false);
  });
});
