import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => {
  class BrowserSqliteError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { open: vi.fn(), BrowserSqliteError };
});

vi.mock('@yelaxis/data/browser', () => ({
  BrowserSqliteDriver: { open: browser.open },
  BrowserSqliteError: browser.BrowserSqliteError,
}));

const data = vi.hoisted(() => ({ migrations: vi.fn(), health: vi.fn() }));
vi.mock('@yelaxis/data', () => ({
  schemaMigrations: [],
  runMigrations: data.migrations,
  checkDatabaseHealth: data.health,
}));

const { deletePlanningDatabase, openPlanningDatabase } = await import('./persistence');

const busy = () => new browser.BrowserSqliteError('database_busy', 'The plan is already open.');

beforeEach(() => {
  browser.open.mockReset();
  data.migrations.mockReset().mockResolvedValue(undefined);
  data.health.mockReset().mockResolvedValue({ integrityCheck: 'ok', foreignKeyViolations: [] });
});
afterEach(() => vi.unstubAllGlobals());

describe('planning database health policy', () => {
  it('defaults to full validation in development without a production fingerprint', async () => {
    const driver = { close: vi.fn() };
    browser.open.mockResolvedValue({ driver, storage: { persistence: 'best-effort' } });
    await openPlanningDatabase();
    expect(data.migrations).toHaveBeenCalledBefore(data.health);
    expect(data.health).toHaveBeenCalledWith(driver, { cachePolicy: undefined });
  });

  it('enables exact-image reuse from the built fingerprint without optional account or Git metadata', async () => {
    const policy = 'a'.repeat(40);
    vi.stubGlobal('__YELAXIS_HEALTH_POLICY__', policy);
    const driver = { close: vi.fn() };
    browser.open.mockResolvedValue({ driver, storage: { persistence: 'best-effort' } });
    await openPlanningDatabase();
    expect(data.health).toHaveBeenCalledWith(driver, { cachePolicy: policy });
  });

  it('closes and rejects a database when validation finds damaged relationships', async () => {
    vi.stubGlobal('__YELAXIS_HEALTH_POLICY__', 'a'.repeat(40));
    const driver = { close: vi.fn().mockResolvedValue(undefined) };
    browser.open.mockResolvedValue({ driver, storage: { persistence: 'best-effort' } });
    data.health.mockResolvedValue({
      integrityCheck: 'ok',
      foreignKeyViolations: [{ table: 'actions' }],
    });
    await expect(openPlanningDatabase()).rejects.toThrow('integrity check');
    expect(driver.close).toHaveBeenCalledTimes(1);
  });
});

describe('deleting a planning database', () => {
  it('opens the database under its own lock and removes it', async () => {
    const destroyDatabase = vi.fn(() => Promise.resolve());
    browser.open.mockResolvedValue({ driver: { destroyDatabase } });
    await deletePlanningDatabase('/yelaxis-account-a.sqlite3', { delayMs: 0 });
    expect(browser.open).toHaveBeenCalledWith({ databaseName: '/yelaxis-account-a.sqlite3' });
    expect(destroyDatabase).toHaveBeenCalledTimes(1);
  });

  it('waits briefly for a lock this tab just released', async () => {
    const destroyDatabase = vi.fn(() => Promise.resolve());
    browser.open
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValue({ driver: { destroyDatabase } });
    await deletePlanningDatabase('/yelaxis-account-a.sqlite3', { delayMs: 0 });
    expect(browser.open).toHaveBeenCalledTimes(3);
    expect(destroyDatabase).toHaveBeenCalledTimes(1);
  });

  it('fails closed while another tab keeps the database open', async () => {
    browser.open.mockRejectedValue(busy());
    await expect(
      deletePlanningDatabase('/yelaxis-account-a.sqlite3', { delayMs: 0, attempts: 3 }),
    ).rejects.toMatchObject({ code: 'database_busy' });
    expect(browser.open).toHaveBeenCalledTimes(3);
  });

  it('does not retry any other failure', async () => {
    browser.open.mockRejectedValue(
      new browser.BrowserSqliteError('storage_unavailable', 'No storage.'),
    );
    await expect(
      deletePlanningDatabase('/yelaxis-account-a.sqlite3', { delayMs: 0 }),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(browser.open).toHaveBeenCalledTimes(1);
  });
});
