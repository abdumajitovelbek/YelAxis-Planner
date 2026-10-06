import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserSqliteDriver } from './browser-driver';
import type { BrowserSqliteRequest, BrowserSqliteResponse } from './protocol';

type Listener = (event: { readonly data: BrowserSqliteResponse }) => void;

/** A dedicated-worker stand-in that answers every request; `destroy` can be made to fail. */
class FakeWorker {
  readonly requests: BrowserSqliteRequest[] = [];
  terminated = false;
  failDestroy = false;
  readonly #listeners = new Set<Listener>();

  addEventListener(type: string, listener: Listener): void {
    if (type === 'message') this.#listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === 'message') this.#listeners.delete(listener);
  }

  postMessage(request: BrowserSqliteRequest): void {
    this.requests.push(request);
    const response: BrowserSqliteResponse =
      request.operation === 'destroy' && this.failDestroy
        ? {
            id: request.id,
            ok: false,
            error: { code: 'database_operation_failed', message: 'Storage refused' },
          }
        : {
            id: request.id,
            ok: true,
            value:
              request.operation === 'init'
                ? { sqliteVersion: '3.0.0', storage: 'indexeddb-snapshot' }
                : undefined,
          };
    queueMicrotask(() => {
      for (const listener of this.#listeners) listener({ data: response });
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

async function openWith(worker: FakeWorker, databaseName = '/yelaxis-account-a.sqlite3') {
  vi.stubGlobal('Worker', FakeWorker);
  const { driver } = await BrowserSqliteDriver.open({
    databaseName,
    workerFactory: () => worker as unknown as Worker,
  });
  return driver;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BrowserSqliteDriver', () => {
  it('retains document-exit retirement after a completed import', async () => {
    const owner = new EventTarget();
    vi.stubGlobal('window', owner);
    const worker = new FakeWorker();
    const driver = await openWith(worker);
    await driver.importDatabase(new Uint8Array([1, 2]), () => Promise.resolve());
    const retiring = new Event('pagehide');
    Object.defineProperty(retiring, 'persisted', { value: false });
    owner.dispatchEvent(retiring);
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.requests.map(({ operation }) => operation)).toEqual([
      'init',
      'beginImport',
      'commitImport',
      'close',
    ]);
    expect(worker.terminated).toBe(true);
  });
  it('queues retirement on document exit while leaving a persisted navigation context usable', async () => {
    const owner = new EventTarget();
    vi.stubGlobal('window', owner);
    const worker = new FakeWorker();
    const driver = await openWith(worker);
    const cached = new Event('pagehide');
    Object.defineProperty(cached, 'persisted', { value: true });
    owner.dispatchEvent(cached);
    expect(worker.requests.map(({ operation }) => operation)).toEqual(['init']);
    expect(worker.terminated).toBe(false);
    const retiring = new Event('pagehide');
    Object.defineProperty(retiring, 'persisted', { value: false });
    owner.dispatchEvent(retiring);
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.requests.map(({ operation }) => operation)).toEqual(['init', 'close']);
    expect(worker.terminated).toBe(true);
    expect(() => driver.get('SELECT 1;')).toThrow(
      expect.objectContaining({ code: 'connection_closed' }),
    );
    owner.dispatchEvent(retiring);
    expect(worker.requests).toHaveLength(2);
  });
  it('opens after 100ms when persistence permission remains pending without claiming a grant', async () => {
    vi.useFakeTimers();
    let grant: (value: boolean) => void = () => undefined;
    vi.stubGlobal('navigator', {
      storage: {
        persisted: () => Promise.resolve(false),
        persist: () => new Promise<boolean>((resolve) => (grant = resolve)),
      },
    });
    const worker = new FakeWorker();
    vi.stubGlobal('Worker', FakeWorker);
    const opening = BrowserSqliteDriver.open({ workerFactory: () => worker as unknown as Worker });
    await vi.advanceTimersByTimeAsync(100);
    const { driver, storage } = await opening;
    expect(storage.durability).toBe('best-effort');
    grant(true);
    await Promise.resolve();
    expect(storage.durability).toBe('best-effort');
    expect(worker.terminated).toBe(false);
    await driver.close();
  });

  it('reports an existing persistence grant without requesting another permission', async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal('navigator', { storage: { persisted: () => Promise.resolve(true), persist } });
    const worker = new FakeWorker();
    vi.stubGlobal('Worker', FakeWorker);
    const { driver, storage } = await BrowserSqliteDriver.open({
      workerFactory: () => worker as unknown as Worker,
    });
    expect(storage.durability).toBe('persistent');
    expect(persist).not.toHaveBeenCalled();
    await driver.close();
  });

  it('preserves a usable best-effort connection when the storage permission API rejects', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persisted: () => Promise.resolve(false),
        persist: () => Promise.reject(new Error('synthetic permission denial')),
      },
    });
    const worker = new FakeWorker();
    vi.stubGlobal('Worker', FakeWorker);
    const { driver, storage } = await BrowserSqliteDriver.open({
      workerFactory: () => worker as unknown as Worker,
    });
    expect(storage.durability).toBe('best-effort');
    expect(worker.terminated).toBe(false);
    await driver.close();
  });

  it('opens the named database in its own worker', async () => {
    const worker = new FakeWorker();
    await openWith(worker, '/yelaxis-local-b.sqlite3');
    expect(worker.requests[0]).toMatchObject({
      operation: 'init',
      databaseName: '/yelaxis-local-b.sqlite3',
    });
  });

  it('removes its database and then refuses every further use', async () => {
    const worker = new FakeWorker();
    const driver = await openWith(worker);

    await driver.destroyDatabase();

    expect(worker.requests.map(({ operation }) => operation)).toEqual(['init', 'destroy']);
    expect(worker.terminated).toBe(true);
    expect(() => driver.run('SELECT 1;')).toThrow(
      expect.objectContaining({ code: 'connection_closed' }),
    );
    await expect(driver.destroyDatabase()).rejects.toMatchObject({ code: 'connection_closed' });
  });

  it('reports a failed removal and still closes its worker', async () => {
    const worker = new FakeWorker();
    worker.failDestroy = true;
    const driver = await openWith(worker);

    await expect(driver.destroyDatabase()).rejects.toMatchObject({
      code: 'database_operation_failed',
    });
    expect(worker.terminated).toBe(true);
  });

  it('refuses to remove a database while a transaction is open', async () => {
    const worker = new FakeWorker();
    const driver = await openWith(worker);
    let release: () => void = () => undefined;
    const transaction = driver.transaction(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    await expect(driver.destroyDatabase()).rejects.toMatchObject({ code: 'database_busy' });
    release();
    await transaction;
    expect(worker.requests.some(({ operation }) => operation === 'destroy')).toBe(false);
    await driver.close();
  });
});
