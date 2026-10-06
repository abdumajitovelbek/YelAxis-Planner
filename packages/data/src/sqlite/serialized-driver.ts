import type {
  SqliteDriver,
  SqliteMigrationTransaction,
  SqliteParameter,
  SqliteRunResult,
  SqliteTransaction,
} from './driver';

/**
 * Queue every top-level operation on one driver so reads and transactions from independent
 * application services never overlap on the browser's single worker connection. Work inside a
 * transaction must use the transaction capability, never the outer driver.
 */
export class SerializedSqliteDriver implements SqliteDriver {
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly driver: SqliteDriver) {}

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  run(sql: string, parameters?: readonly SqliteParameter[]): Promise<SqliteRunResult> {
    return this.#enqueue(() => this.driver.run(sql, parameters));
  }

  get<Row extends object>(
    sql: string,
    parameters?: readonly SqliteParameter[],
  ): Promise<Row | undefined> {
    return this.#enqueue(() => this.driver.get<Row>(sql, parameters));
  }

  all<Row extends object>(sql: string, parameters?: readonly SqliteParameter[]): Promise<Row[]> {
    return this.#enqueue(() => this.driver.all<Row>(sql, parameters));
  }

  executeScript(sql: string): Promise<void> {
    return this.#enqueue(() => this.driver.executeScript(sql));
  }

  transaction<Result>(
    operation: (transaction: SqliteTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#enqueue(() => this.driver.transaction(operation));
  }

  migrationTransaction<Result>(
    operation: (transaction: SqliteMigrationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#enqueue(() => this.driver.migrationTransaction(operation));
  }

  close(): Promise<void> {
    return this.#enqueue(() => this.driver.close());
  }
}
