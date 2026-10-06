/**
 * Test-only real SQLite driver over `node:sqlite` (the data package keeps its own Node driver
 * internal). One connection, foreign keys on, immediate transactions, and the same rule as the
 * browser driver: work inside a transaction uses only its transaction capability.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { normalizeSearchText } from '@yelaxis/data';

import type {
  SqliteDriver,
  SqliteMigrationTransaction,
  SqliteParameter,
  SqliteRunResult,
  SqliteTransaction,
} from '@yelaxis/data';

export interface StatementHook {
  /** Called before every statement inside a transaction; throw to inject a failure. */
  (sql: string): void;
}

export class NodeSqliteTestDriver implements SqliteDriver {
  readonly #database: DatabaseSync;
  #inTransaction = false;
  /** Injected failure point for atomicity tests. */
  beforeStatement: StatementHook | null = null;
  statementCount = 0;

  constructor(path: string) {
    this.#database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      readBigInts: false,
      timeout: 5_000,
    });
    this.#database.exec('PRAGMA foreign_keys = ON;');
    this.#database.function(
      'yelaxis_search_normalize',
      { deterministic: true },
      normalizeSearchText,
    );
  }

  run(sql: string, parameters: readonly SqliteParameter[] = []): Promise<SqliteRunResult> {
    return Promise.resolve().then(() => this.#run(sql, parameters));
  }

  get<Row extends object>(
    sql: string,
    parameters: readonly SqliteParameter[] = [],
  ): Promise<Row | undefined> {
    return Promise.resolve().then(
      () => this.#statement(sql).get(...native(parameters)) as Row | undefined,
    );
  }

  all<Row extends object>(
    sql: string,
    parameters: readonly SqliteParameter[] = [],
  ): Promise<Row[]> {
    return Promise.resolve().then(() => this.#statement(sql).all(...native(parameters)) as Row[]);
  }

  executeScript(sql: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.#database.exec(sql);
    });
  }

  transaction<Result>(
    operation: (transaction: SqliteTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#transaction(operation);
  }

  migrationTransaction<Result>(
    operation: (transaction: SqliteMigrationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#transaction(operation);
  }

  close(): Promise<void> {
    this.#database.close();
    return Promise.resolve();
  }

  async #transaction<Result>(
    operation: (transaction: SqliteMigrationTransaction) => Promise<Result>,
  ): Promise<Result> {
    if (this.#inTransaction) throw new Error('SQLite transaction unavailable');
    this.#inTransaction = true;
    let active = true;
    const guard = (): void => {
      if (!active) throw new Error('SQLite transaction capability expired');
    };
    const hook = (sql: string): void => {
      this.statementCount += 1;
      this.beforeStatement?.(sql);
    };
    const transaction: SqliteMigrationTransaction = {
      run: (sql, parameters = []) =>
        Promise.resolve().then(() => {
          guard();
          hook(sql);
          return this.#run(sql, parameters);
        }),
      get: <Row extends object>(
        sql: string,
        parameters: readonly SqliteParameter[] = [],
      ): Promise<Row | undefined> =>
        Promise.resolve().then((): Row | undefined => {
          guard();
          hook(sql);
          return this.#statement(sql).get(...native(parameters)) as Row | undefined;
        }),
      all: <Row extends object>(
        sql: string,
        parameters: readonly SqliteParameter[] = [],
      ): Promise<Row[]> =>
        Promise.resolve().then((): Row[] => {
          guard();
          hook(sql);
          return this.#statement(sql).all(...native(parameters)) as Row[];
        }),
      executeScript: (sql) =>
        Promise.resolve().then(() => {
          guard();
          this.#database.exec(sql);
        }),
    };
    try {
      this.#database.exec('BEGIN IMMEDIATE;');
      try {
        const result = await operation(transaction);
        active = false;
        this.#database.exec('COMMIT;');
        return result;
      } catch (error) {
        active = false;
        if (this.#database.isTransaction) this.#database.exec('ROLLBACK;');
        throw error;
      }
    } finally {
      this.#inTransaction = false;
    }
  }

  #statement(sql: string) {
    return this.#database.prepare(sql);
  }

  #run(sql: string, parameters: readonly SqliteParameter[]): SqliteRunResult {
    const result = this.#statement(sql).run(...native(parameters));
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }
}

function native(parameters: readonly SqliteParameter[]): SQLInputValue[] {
  return parameters.map((parameter) => parameter);
}
