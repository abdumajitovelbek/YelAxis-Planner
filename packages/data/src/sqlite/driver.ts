import type { DatabaseHealth } from './health';

export type SqliteParameter = null | number | string | Uint8Array;

export type SqliteRunResult = Readonly<{
  changes: number;
  lastInsertRowId: number;
}>;

/**
 * Smallest database surface needed by migrations and repository adapters.
 * Implementations may be synchronous internally, but the application-facing
 * boundary stays asynchronous for parity with the native driver.
 */
export interface SqliteQueryConnection {
  run(sql: string, parameters?: readonly SqliteParameter[]): Promise<SqliteRunResult>;
  get<Row extends object>(
    sql: string,
    parameters?: readonly SqliteParameter[],
  ): Promise<Row | undefined>;
  all<Row extends object>(sql: string, parameters?: readonly SqliteParameter[]): Promise<Row[]>;
}

export interface SqliteConnection extends SqliteQueryConnection {
  executeScript(sql: string): Promise<void>;
}

/** Query-only transaction capability with no script, nesting, or lifecycle methods. */
export type SqliteTransaction = SqliteQueryConnection;

/** Source-controlled migration capability; never exposed through application UnitOfWork. */
export interface SqliteMigrationTransaction extends SqliteTransaction {
  executeScript(sql: string): Promise<void>;
}

export interface SqliteDriver extends SqliteConnection {
  /** Optional worker capability: reuse a full-health result only for identical bytes/policy/engine. */
  checkedHealth?(policy: string): Promise<DatabaseHealth>;
  transaction<Result>(
    operation: (transaction: SqliteTransaction) => Promise<Result>,
  ): Promise<Result>;
  migrationTransaction<Result>(
    operation: (transaction: SqliteMigrationTransaction) => Promise<Result>,
  ): Promise<Result>;
  close(): Promise<void>;
}
