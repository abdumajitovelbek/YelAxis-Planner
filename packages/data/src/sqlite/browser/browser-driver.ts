import type {
  SqliteDriver,
  SqliteMigrationTransaction,
  SqliteParameter,
  SqliteRunResult,
  SqliteTransaction,
} from '../driver';
import { assertTransactionStatementAllowed } from '../transaction-sql';
import type { DatabaseHealth } from '../health';
import type {
  BrowserSqliteRequest,
  BrowserSqliteResponse,
  BrowserSqliteWorkerErrorCode,
  BrowserSqliteWorkerInit,
} from './protocol';

export type BrowserStorageDurability = 'best-effort' | 'persistent';

export type BrowserStorageStatus = Readonly<{
  backend: 'indexeddb-snapshot';
  browserManaged: true;
  durability: BrowserStorageDurability;
  sqliteVersion: string;
}>;

export interface BrowserSqliteDriverOptions {
  readonly databaseName?: string;
  readonly workerFactory?: () => Worker;
}

export type BrowserDatabaseValidator = (driver: SqliteDriver) => Promise<void>;

export class BrowserSqliteError extends Error {
  readonly code: BrowserSqliteWorkerErrorCode | 'connection_closed' | 'connection_unavailable';

  constructor(code: BrowserSqliteError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BrowserSqliteError';
    this.code = code;
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface TransactionScope {
  readonly migrationTransaction: SqliteMigrationTransaction;
  readonly transaction: SqliteTransaction;
  deactivate(): void;
  drain(): Promise<void>;
  isIdle(): boolean;
}

/**
 * Main-thread proxy for the dedicated SQLite WASM worker.
 *
 * SQL and IndexedDB snapshot work never runs on the UI thread. The proxy preserves the same
 * admission, transaction ownership, and expiring capability rules as the
 * shared driver contract and test-only Node driver.
 */
export class BrowserSqliteDriver implements SqliteDriver {
  readonly #worker: Worker;
  readonly #pending = new Map<number, PendingRequest>();
  #closed = false;
  #nextRequestId = 1;
  #publicOperationsInFlight = 0;
  #transactionActive = false;

  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.addEventListener('message', this.#handleMessage);
    worker.addEventListener('error', this.#handleWorkerFailure);
    worker.addEventListener('messageerror', this.#handleWorkerFailure);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.#handlePageHide);
  }

  static async open(
    options: BrowserSqliteDriverOptions = {},
  ): Promise<{ driver: BrowserSqliteDriver; storage: BrowserStorageStatus }> {
    if (typeof Worker === 'undefined' || typeof navigator === 'undefined') {
      throw new BrowserSqliteError(
        'storage_unavailable',
        'Browser workers and storage APIs are unavailable.',
      );
    }

    const worker =
      options.workerFactory?.() ??
      new Worker(new URL('./sqlite-worker.ts', import.meta.url), {
        name: 'yelaxis-sqlite',
        type: 'module',
      });
    const driver = new BrowserSqliteDriver(worker);

    try {
      const initialized = await driver.#request<BrowserSqliteWorkerInit>({
        operation: 'init',
        ...(options.databaseName === undefined ? {} : { databaseName: options.databaseName }),
      });
      const durability = await requestPersistentStorage();
      return {
        driver,
        storage: {
          backend: initialized.storage,
          browserManaged: true,
          durability,
          sqliteVersion: initialized.sqliteVersion,
        },
      };
    } catch (error) {
      driver.#failConnection(error);
      throw error;
    }
  }

  executeScript(sql: string): Promise<void> {
    return this.#performPublicOperation(() =>
      this.#request<void>({ operation: 'executeScript', sql }),
    );
  }

  checkedHealth(policy: string): Promise<DatabaseHealth> {
    return this.#performPublicOperation(() =>
      this.#request<DatabaseHealth>({
        operation: 'checkedHealth',
        healthPolicy: policy,
      }),
    );
  }

  run(sql: string, parameters: readonly SqliteParameter[] = []): Promise<SqliteRunResult> {
    return this.#performPublicOperation(() =>
      this.#request<SqliteRunResult>({ operation: 'run', sql, parameters }),
    );
  }

  get<Row extends object>(
    sql: string,
    parameters: readonly SqliteParameter[] = [],
  ): Promise<Row | undefined> {
    return this.#performPublicOperation(() =>
      this.#request<Row | undefined>({ operation: 'get', sql, parameters }),
    );
  }

  all<Row extends object>(
    sql: string,
    parameters: readonly SqliteParameter[] = [],
  ): Promise<Row[]> {
    return this.#performPublicOperation(() =>
      this.#request<Row[]>({ operation: 'all', sql, parameters }),
    );
  }

  transaction<Result>(
    operation: (transaction: SqliteTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#runTransaction((scope) => operation(scope.transaction), true);
  }

  migrationTransaction<Result>(
    operation: (transaction: SqliteMigrationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#runTransaction((scope) => operation(scope.migrationTransaction), true);
  }

  exportDatabase(): Promise<Uint8Array> {
    return this.#performPublicOperation(async () => {
      const bytes = await this.#request<ArrayBuffer>({ operation: 'export' });
      return new Uint8Array(bytes);
    });
  }

  async importDatabase(bytes: Uint8Array, validate: BrowserDatabaseValidator): Promise<void> {
    this.#assertOpen();
    if (this.#publicOperationsInFlight > 0 || this.#transactionActive) {
      throw new BrowserSqliteError('database_busy', 'The browser database is busy.');
    }
    if (bytes.byteLength === 0) {
      throw new BrowserSqliteError('invalid_request', 'A non-empty database backup is required.');
    }

    this.#transactionActive = true;
    const transferable = Uint8Array.from(bytes).buffer;
    try {
      await this.#request<void>({ operation: 'beginImport', bytes: transferable }, [transferable]);
      try {
        await validate(this.#maintenanceDriver());
        await this.#request<void>({ operation: 'commitImport' });
      } catch (error) {
        await this.#request<void>({ operation: 'rollbackImport' });
        throw error;
      }
    } finally {
      this.#transactionActive = false;
    }
  }

  async close(): Promise<void> {
    await this.#finish('close');
  }

  /**
   * Removes this database from browser storage and closes it (account sync removing an account's copy from
   * this device). It runs under this connection's Web Lock, so a database open in another tab is
   * never removed; other databases are untouched.
   */
  async destroyDatabase(): Promise<void> {
    await this.#finish('destroy');
  }

  async #finish(operation: 'close' | 'destroy'): Promise<void> {
    this.#assertOpen();
    if (this.#publicOperationsInFlight > 0 || this.#transactionActive) {
      throw new BrowserSqliteError('database_busy', 'The browser database is busy.');
    }
    this.#closed = true;
    try {
      await this.#request<void>({ operation });
    } finally {
      if (typeof window !== 'undefined')
        window.removeEventListener('pagehide', this.#handlePageHide);
      this.#worker.removeEventListener('message', this.#handleMessage);
      this.#worker.removeEventListener('error', this.#handleWorkerFailure);
      this.#worker.removeEventListener('messageerror', this.#handleWorkerFailure);
      this.#worker.terminate();
      this.#rejectPending(
        new BrowserSqliteError('connection_closed', 'The browser database is closed.'),
      );
    }
  }

  async #runTransaction<Result>(
    operation: (scope: TransactionScope) => Promise<Result>,
    enforceAdmission: boolean,
  ): Promise<Result> {
    this.#assertOpen();
    if (enforceAdmission && (this.#publicOperationsInFlight > 0 || this.#transactionActive)) {
      throw new BrowserSqliteError('database_busy', 'The browser database is busy.');
    }

    const ownsAdmission = enforceAdmission;
    if (ownsAdmission) this.#transactionActive = true;
    const scope = this.#createTransactionScope();
    let began = false;

    try {
      await this.#request<void>({ operation: 'executeScript', sql: 'BEGIN IMMEDIATE;' });
      began = true;
      const result = await operation(scope);
      const idle = scope.isIdle();
      await scope.drain();
      scope.deactivate();
      if (!idle) {
        throw new BrowserSqliteError(
          'database_busy',
          'The transaction scope has pending operations.',
        );
      }
      await this.#request<void>({ operation: 'executeScript', sql: 'COMMIT;' });
      return result;
    } catch (error) {
      await scope.drain();
      scope.deactivate();
      if (began) {
        try {
          await this.#request<void>({ operation: 'executeScript', sql: 'ROLLBACK;' });
        } catch {
          // Preserve the original operation failure.
        }
      }
      throw error;
    } finally {
      if (ownsAdmission) this.#transactionActive = false;
    }
  }

  #maintenanceDriver(): SqliteDriver {
    return {
      executeScript: (sql) => this.#request<void>({ operation: 'executeScript', sql }),
      run: (sql, parameters = []) =>
        this.#request<SqliteRunResult>({ operation: 'run', sql, parameters }),
      get: <Row extends object>(sql: string, parameters: readonly SqliteParameter[] = []) =>
        this.#request<Row | undefined>({ operation: 'get', sql, parameters }),
      all: <Row extends object>(sql: string, parameters: readonly SqliteParameter[] = []) =>
        this.#request<Row[]>({ operation: 'all', sql, parameters }),
      transaction: <Result>(operation: (transaction: SqliteTransaction) => Promise<Result>) =>
        this.#runTransaction((scope) => operation(scope.transaction), false),
      migrationTransaction: <Result>(
        operation: (transaction: SqliteMigrationTransaction) => Promise<Result>,
      ) => this.#runTransaction((scope) => operation(scope.migrationTransaction), false),
      close: () =>
        Promise.reject(
          new BrowserSqliteError(
            'database_busy',
            'The validation capability cannot close the database.',
          ),
        ),
    };
  }

  #createTransactionScope(): TransactionScope {
    let active = true;
    let operationActive = false;
    const pending = new Set<Promise<unknown>>();

    const perform = <Result>(operation: () => Promise<Result>): Promise<Result> => {
      if (!active) {
        return Promise.reject(
          new BrowserSqliteError('database_busy', 'The transaction capability has expired.'),
        );
      }
      if (operationActive) {
        return Promise.reject(
          new BrowserSqliteError(
            'database_busy',
            'Concurrent transaction operations are not allowed.',
          ),
        );
      }

      operationActive = true;
      const result = Promise.resolve()
        .then(operation)
        .finally(() => {
          operationActive = false;
          pending.delete(result);
        });
      pending.add(result);
      return result;
    };

    const transaction: SqliteTransaction = {
      run: (sql, parameters = []) =>
        perform(() => {
          assertTransactionStatementAllowed(sql);
          return this.#request<SqliteRunResult>({ operation: 'run', sql, parameters });
        }),
      get: <Row extends object>(sql: string, parameters: readonly SqliteParameter[] = []) =>
        perform(() => {
          assertTransactionStatementAllowed(sql);
          return this.#request<Row | undefined>({ operation: 'get', sql, parameters });
        }),
      all: <Row extends object>(sql: string, parameters: readonly SqliteParameter[] = []) =>
        perform(() => {
          assertTransactionStatementAllowed(sql);
          return this.#request<Row[]>({ operation: 'all', sql, parameters });
        }),
    };

    return {
      transaction,
      migrationTransaction: {
        ...transaction,
        executeScript: (sql) =>
          perform(() => this.#request<void>({ operation: 'executeScript', sql })),
      },
      deactivate: () => {
        active = false;
      },
      drain: async () => {
        await Promise.allSettled([...pending]);
      },
      isIdle: () => pending.size === 0,
    };
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new BrowserSqliteError('connection_closed', 'The browser database is closed.');
    }
  }

  #performPublicOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.#assertOpen();
    if (this.#transactionActive || this.#publicOperationsInFlight > 0) {
      throw new BrowserSqliteError('database_busy', 'The browser database is busy.');
    }
    this.#publicOperationsInFlight += 1;
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.#publicOperationsInFlight -= 1;
      });
  }

  #request<Result>(
    request: Omit<BrowserSqliteRequest, 'id'>,
    transfer: Transferable[] = [],
  ): Promise<Result> {
    if (this.#closed && request.operation !== 'close' && request.operation !== 'destroy') {
      return Promise.reject(
        new BrowserSqliteError('connection_closed', 'The browser database is closed.'),
      );
    }

    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise<Result>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as Result),
        reject,
      });
      this.#worker.postMessage({ ...request, id } satisfies BrowserSqliteRequest, transfer);
    });
  }

  readonly #handleMessage = (event: MessageEvent<BrowserSqliteResponse>): void => {
    const response = event.data;
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);

    if (response.ok) {
      pending.resolve(response.value);
      return;
    }
    pending.reject(new BrowserSqliteError(response.error.code, response.error.message));
  };

  readonly #handleWorkerFailure = (event: Event): void => {
    const message = event instanceof ErrorEvent ? event.message : 'The database worker failed.';
    this.#failConnection(
      new BrowserSqliteError('connection_unavailable', message || 'The database worker failed.'),
    );
  };

  readonly #handlePageHide = (event: PageTransitionEvent): void => {
    if (event.persisted || this.#closed) return;
    // Queue shutdown after accepted worker messages. Do not destroy durable snapshots or terminate
    // before SQLite can close/retire its private file allocations. A cached document stays usable.
    void this.#request<void>({ operation: 'close' }).then(
      () =>
        this.#failConnection(new BrowserSqliteError('connection_closed', 'The document closed.')),
      (error: unknown) => this.#failConnection(error),
    );
  };

  #failConnection(error: unknown): void {
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.#handlePageHide);
    this.#closed = true;
    this.#worker.terminate();
    this.#rejectPending(error);
  }

  #rejectPending(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

async function requestPersistentStorage(): Promise<BrowserStorageDurability> {
  const storage = navigator.storage;
  if (storage === undefined) return 'best-effort';

  try {
    return await withTimeout(
      (async () => {
        if (await storage.persisted()) return 'persistent';
        return (await storage.persist()) ? 'persistent' : 'best-effort';
      })(),
      // A pending browser permission prompt must not hold the useful local screen hostage.
      // A late grant is observed on the next open; until then best-effort remains an honest claim.
      100,
      'best-effort',
    );
  } catch {
    return 'best-effort';
  }
}

async function withTimeout<Result>(
  operation: Promise<Result>,
  milliseconds: number,
  fallback: Result,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<Result>((resolve) => {
        timer = setTimeout(() => resolve(fallback), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type { BrowserSqliteWorkerErrorCode, BrowserSqliteWorkerInit } from './protocol';
