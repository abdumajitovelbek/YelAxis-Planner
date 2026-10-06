import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { deletePlanningDatabase } = await import('./persistence');

const busy = () => new browser.BrowserSqliteError('database_busy', 'The plan is already open.');

beforeEach(() => {
  browser.open.mockReset();
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
