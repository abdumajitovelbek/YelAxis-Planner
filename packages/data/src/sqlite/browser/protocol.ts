import type { SqliteParameter, SqliteRunResult } from '../driver';

export type BrowserSqliteOperation =
  | 'all'
  | 'beginImport'
  | 'close'
  | 'commitImport'
  | 'destroy'
  | 'executeScript'
  | 'export'
  | 'get'
  | 'checkedHealth'
  | 'init'
  | 'rollbackImport'
  | 'run';

export type BrowserSqliteRequest = Readonly<{
  id: number;
  operation: BrowserSqliteOperation;
  sql?: string;
  parameters?: readonly SqliteParameter[];
  bytes?: ArrayBuffer;
  databaseName?: string;
  healthPolicy?: string;
}>;

export type BrowserSqliteResponse =
  | Readonly<{
      id: number;
      ok: true;
      value?: unknown;
    }>
  | Readonly<{
      id: number;
      ok: false;
      error: Readonly<{
        code: BrowserSqliteWorkerErrorCode;
        message: string;
      }>;
    }>;

export type BrowserSqliteWorkerErrorCode =
  | 'database_busy'
  | 'database_closed'
  | 'database_corrupt'
  | 'database_operation_failed'
  | 'invalid_request'
  | 'storage_unavailable';

export type BrowserSqliteWorkerInit = Readonly<{
  sqliteVersion: string;
  storage: 'indexeddb-snapshot';
}>;

export type BrowserSqliteWorkerRunResult = SqliteRunResult;
