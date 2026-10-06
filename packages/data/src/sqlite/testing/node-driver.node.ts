import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { normalizeSearchText } from '../../search/search-normalization';

import type {
  SqliteDriver,
  SqliteMigrationTransaction,
  SqliteParameter,
  SqliteRunResult,
  SqliteTransaction,
} from '../driver';
import { assertTransactionStatementAllowed } from '../transaction-sql';

function nativeParameters(parameters: readonly SqliteParameter[]): SQLInputValue[] {
  return parameters.map((parameter) => parameter);
}

function safeInteger(value: number | bigint, field: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue)) {
    throw new RangeError(`${field} exceeded the JavaScript safe integer range`);
  }
  return numberValue;
}

interface TransactionScope {
  readonly migrationTransaction: SqliteMigrationTransaction;
  readonly transaction: SqliteTransaction;
  deactivate(): void;
  drain(): Promise<void>;
  isIdle(): boolean;
}

export interface NodeSqliteDriverOptions {
  readonly busyTimeoutMs?: number;
}

/** Node-only real SQLite driver for migration and repository integration tests. */
export class NodeSqliteDriver implements SqliteDriver {
  readonly #database: DatabaseSync;
  #closed = false;
  #publicOperationsInFlight = 0;
  #transactionActive = false;

  constructor(path: string, options: NodeSqliteDriverOptions = {}) {
    this.#database = new DatabaseSync(path, {
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readBigInts: false,
      timeout: options.busyTimeoutMs ?? 5_000,
    });
    this.#database.exec('PRAGMA foreign_keys = ON;');
    this.#database.function(
      'yelaxis_search_normalize',
      { deterministic: true },
      normalizeSearchText,
    );
  }

  executeScript(sql: string): Promise<void> {
    return this.#performPublicOperation(() => this.#executeScript(sql));
  }

  run(sql: string, parameters: readonly SqliteParameter[] = []): Promise<SqliteRunResult> {
    return this.#performPublicOperation(() => this.#run(sql, parameters));
  }

  get<Row extends object>(
    sql: string,
    parameters: readonly SqliteParameter[] = [],
  ): Promise<Row | undefined> {
    return this.#performPublicOperation(() => this.#get<Row>(sql, parameters));
  }

  all<Row extends object>(
    sql: string,
    parameters: readonly SqliteParameter[] = [],
  ): Promise<Row[]> {
    return this.#performPublicOperation(() => this.#all<Row>(sql, parameters));
  }

  transaction<Result>(
    operation: (transaction: SqliteTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#runTransaction((scope) => operation(scope.transaction));
  }

  migrationTransaction<Result>(
    operation: (transaction: SqliteMigrationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#runTransaction((scope) => operation(scope.migrationTransaction));
  }

  async #runTransaction<Result>(
    operation: (scope: TransactionScope) => Promise<Result>,
  ): Promise<Result> {
    this.#assertOpen();
    if (
      this.#publicOperationsInFlight > 0 ||
      this.#transactionActive ||
      this.#database.isTransaction
    ) {
      throw new Error('SQLite transaction unavailable');
    }

    this.#transactionActive = true;
    const scope = this.#createTransactionScope();
    let began = false;

    try {
      this.#database.exec('BEGIN IMMEDIATE;');
      began = true;
      const result = await operation(scope);
      const idle = scope.isIdle();
      await scope.drain();
      scope.deactivate();
      if (!idle) throw new Error('SQLite transaction scope has pending operations');
      this.#database.exec('COMMIT;');
      return result;
    } catch (error) {
      await scope.drain();
      scope.deactivate();
      if (began) {
        try {
          this.#database.exec('ROLLBACK;');
        } catch {
          // Preserve the original operation failure; connection health is checked by the caller.
        }
      }
      throw error;
    } finally {
      this.#transactionActive = false;
    }
  }

  close(): Promise<void> {
    this.#assertOpen();
    if (this.#publicOperationsInFlight > 0 || this.#transactionActive) {
      throw new Error('SQLite connection is busy');
    }
    this.#closed = true;
    return Promise.resolve().then(() => {
      this.#database.close();
    });
  }

  #executeScript(sql: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.#database.exec(sql);
    });
  }

  #run(sql: string, parameters: readonly SqliteParameter[]): Promise<SqliteRunResult> {
    return Promise.resolve().then(() => {
      const result = this.#database.prepare(sql).run(...nativeParameters(parameters));
      return {
        changes: safeInteger(result.changes, 'changes'),
        lastInsertRowId: safeInteger(result.lastInsertRowid, 'lastInsertRowId'),
      };
    });
  }

  #get<Row extends object>(
    sql: string,
    parameters: readonly SqliteParameter[],
  ): Promise<Row | undefined> {
    return Promise.resolve().then(
      () => this.#database.prepare(sql).get(...nativeParameters(parameters)) as Row | undefined,
    );
  }

  #all<Row extends object>(sql: string, parameters: readonly SqliteParameter[]): Promise<Row[]> {
    return Promise.resolve().then(
      () => this.#database.prepare(sql).all(...nativeParameters(parameters)) as Row[],
    );
  }

  #createTransactionScope(): TransactionScope {
    let active = true;
    let operationActive = false;
    const pending = new Set<Promise<unknown>>();

    const perform = <Result>(operation: () => Promise<Result>): Promise<Result> => {
      if (!active) return Promise.reject(new Error('SQLite transaction capability expired'));
      if (operationActive) {
        return Promise.reject(new Error('Concurrent SQLite transaction operation rejected'));
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
          return this.#run(sql, parameters);
        }),
      get: <Row extends object>(sql: string, parameters: readonly SqliteParameter[] = []) =>
        perform(() => {
          assertTransactionStatementAllowed(sql);
          return this.#get<Row>(sql, parameters);
        }),
      all: <Row extends object>(sql: string, parameters: readonly SqliteParameter[] = []) =>
        perform(() => {
          assertTransactionStatementAllowed(sql);
          return this.#all<Row>(sql, parameters);
        }),
    };

    return {
      transaction,
      migrationTransaction: {
        ...transaction,
        executeScript: (sql) => perform(() => this.#executeScript(sql)),
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
    if (this.#closed) throw new Error('SQLite connection is closed');
  }

  #assertPublicOperationAllowed(): void {
    this.#assertOpen();
    if (this.#transactionActive) {
      throw new Error('SQLite connection is transaction-bound');
    }
  }

  #performPublicOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.#assertPublicOperationAllowed();
    this.#publicOperationsInFlight += 1;
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.#publicOperationsInFlight -= 1;
      });
  }
}
