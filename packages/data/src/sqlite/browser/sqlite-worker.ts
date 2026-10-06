/// <reference lib="webworker" />

import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import sqliteWasmUrl from 'wa-sqlite/dist/wa-sqlite.wasm?url';
import * as SQLite from 'wa-sqlite';

import { normalizeSearchText } from '../../search/search-normalization';

import type { SqliteParameter } from '../driver';
import { acquireDatabaseLock } from './database-lock';
import { BoundedMemoryVFS } from './bounded-memory-vfs';
import { isConnectionConfiguration } from './connection-configuration';
import { imageHealthProof, matchesHealthProof } from './health-proof';
import type { DatabaseHealth, ForeignKeyViolation } from '../health';
import {
  decodeSnapshotValue,
  encodeSnapshotValue,
  exactSnapshotBuffer,
  type EncodedSnapshot,
} from './snapshot-bytes';
import { retireOwnedSnapshot } from './retire-snapshot';
import type {
  BrowserSqliteRequest,
  BrowserSqliteResponse,
  BrowserSqliteWorkerErrorCode,
  BrowserSqliteWorkerInit,
  BrowserSqliteWorkerRunResult,
} from './protocol';

const workerScope = globalThis as unknown as DedicatedWorkerGlobalScope;
const defaultDatabaseName = '/yelaxis.sqlite3';
const snapshotDatabaseName = 'yelaxis-sqlite-snapshots-v1';
const snapshotStoreName = 'databases';
const healthStoreName = 'checked-images';
const openFlags = SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE;

type MemoryFile = {
  name: string;
  flags: number;
  size: number;
  data: ArrayBuffer;
};

let sqlite: SQLiteAPI | undefined;
let database: number | undefined;
let memoryVfs: BoundedMemoryVFS | undefined;
let snapshotDatabase: IDBDatabase | undefined;
let activeDatabaseName = defaultDatabaseName;
let releaseDatabaseLock: (() => void) | undefined;
let transactionSnapshot: EncodedSnapshot | undefined;
let transactionActive = false;

let requestQueue = Promise.resolve();

workerScope.onmessage = (event: MessageEvent<BrowserSqliteRequest>) => {
  requestQueue = requestQueue.then(() => handleRequest(event.data));
};

async function handleRequest(request: BrowserSqliteRequest): Promise<void> {
  try {
    const value = await dispatch(request);
    const response: BrowserSqliteResponse = { id: request.id, ok: true, value };
    const transfer =
      value instanceof ArrayBuffer ? [value] : value instanceof Uint8Array ? [value.buffer] : [];
    workerScope.postMessage(response, transfer);
  } catch (error) {
    const response: BrowserSqliteResponse = {
      id: request.id,
      ok: false,
      error: normalizeError(error),
    };
    workerScope.postMessage(response);
  }
}

async function dispatch(request: BrowserSqliteRequest): Promise<unknown> {
  switch (request.operation) {
    case 'init':
      return await initialize(request.databaseName);
    case 'run':
      return await durableMutation(() => run(requireSql(request), request.parameters ?? []));
    case 'get':
      return await get(requireSql(request), request.parameters ?? []);
    case 'all':
      return await all(requireSql(request), request.parameters ?? []);
    case 'checkedHealth':
      return await checkedHealth(request.healthPolicy);
    case 'executeScript':
      return await executeScript(requireSql(request));
    case 'export':
      return exportDatabase();
    case 'beginImport':
      return await beginImport(requireBytes(request));
    case 'commitImport':
      return await commitImport();
    case 'rollbackImport':
      return await rollbackImport();
    case 'close':
      await close();
      return undefined;
    case 'destroy':
      await destroy();
      return undefined;
  }
}

async function initialize(databaseName = defaultDatabaseName): Promise<BrowserSqliteWorkerInit> {
  if (database !== undefined) {
    throw workerError('database_busy', 'The browser database is already open.');
  }
  if (typeof indexedDB === 'undefined' || typeof navigator.locks?.request !== 'function') {
    throw workerError(
      'storage_unavailable',
      'This browser does not expose IndexedDB and Web Locks in a worker.',
    );
  }

  activeDatabaseName = normalizeDatabaseName(databaseName);

  try {
    releaseDatabaseLock = await acquireDatabaseLock(navigator.locks, activeDatabaseName);
    snapshotDatabase = await openSnapshotDatabase();
    await restoreInterruptedImport();

    if (sqlite === undefined) {
      const wasmResponse = await fetch(sqliteWasmUrl);
      if (!wasmResponse.ok) {
        throw workerError('storage_unavailable', 'The SQLite WebAssembly binary could not load.');
      }
      const module: unknown = await SQLiteESMFactory({
        wasmBinary: await wasmResponse.arrayBuffer(),
      });
      sqlite = SQLite.Factory(module);
      memoryVfs = new BoundedMemoryVFS();
      sqlite.vfs_register(memoryVfs as unknown as SQLiteVFS, true);
    }

    const persisted = await readSnapshot(activeSnapshotKey());
    // IndexedDB returned an isolated, worker-owned clone. Adopting it cannot change stored bytes.
    // General rollback/import callers still receive defensive copies below.
    await openDatabase(persisted, true);
    return {
      sqliteVersion: sqlite.libversion(),
      storage: 'indexeddb-snapshot',
    };
  } catch (error) {
    await close();
    if (isWorkerError(error)) throw error;
    throw workerError(
      'storage_unavailable',
      error instanceof Error ? error.message : 'Persistent browser storage could not be opened.',
    );
  }
}

async function executeScript(sql: string): Promise<void> {
  const control = transactionControl(sql);
  if (control === 'begin') {
    if (transactionActive) {
      throw workerError('database_busy', 'A database transaction is already active.');
    }
    transactionSnapshot = await encodeSnapshotValue(currentFileBytes());
    await requireSqlite().exec(requireDatabase(), sql);
    transactionActive = true;
    return;
  }
  if (control === 'commit') {
    if (!transactionActive || transactionSnapshot === undefined) {
      throw workerError('database_operation_failed', 'No database transaction is active.');
    }
    const before = transactionSnapshot;
    await requireSqlite().exec(requireDatabase(), sql);
    try {
      await persistActiveSnapshot();
    } catch (error) {
      await restoreBeforeImage(before);
      throw error;
    } finally {
      retireBeforeImage(before);
      transactionSnapshot = undefined;
      transactionActive = false;
    }
    return;
  }
  if (control === 'rollback') {
    await requireSqlite().exec(requireDatabase(), sql);
    if (transactionSnapshot !== undefined) retireBeforeImage(transactionSnapshot);
    transactionSnapshot = undefined;
    transactionActive = false;
    return;
  }

  // Enabling per-connection FK enforcement changes no database bytes. Avoid a whole-image write
  // on every verified reopen; concatenated or persistent pragmas still take the durable path.
  if (isConnectionConfiguration(sql)) {
    await requireSqlite().exec(requireDatabase(), sql);
    return;
  }
  await durableMutation(async () => {
    await requireSqlite().exec(requireDatabase(), sql);
  });
}

async function durableMutation<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
  if (transactionActive) return await operation();
  const before = await encodeSnapshotValue(currentFileBytes());
  try {
    return await mutateAndPersist(operation, before);
  } finally {
    retireBeforeImage(before);
  }
}

async function mutateAndPersist<Result>(
  operation: () => Result | Promise<Result>,
  before: EncodedSnapshot,
): Promise<Result> {
  let result: Result;
  try {
    result = await operation();
  } catch (error) {
    await restoreBeforeImage(before);
    throw error;
  }
  try {
    await persistActiveSnapshot();
    return result;
  } catch (error) {
    await restoreBeforeImage(before);
    throw workerError(
      'database_operation_failed',
      'The browser could not durably save the database operation.',
      error,
    );
  }
}

async function restoreBeforeImage(before: EncodedSnapshot): Promise<void> {
  const bytes = await decodeSnapshotValue(before);
  if (bytes === undefined)
    throw workerError('database_corrupt', 'The private rollback image is unavailable.');
  // This newly decoded image is exclusively owned by this worker, just like an initial IDB read.
  await openDatabase(bytes, true);
}

function retireBeforeImage(before: EncodedSnapshot): void {
  retireOwnedSnapshot(new Uint8Array(before.bytes));
}

async function run(
  sql: string,
  parameters: readonly SqliteParameter[],
): Promise<BrowserSqliteWorkerRunResult> {
  const api = requireSqlite();
  const db = requireDatabase();
  await api.run(db, sql, [...parameters]);
  const changes = safeInteger(api.changes(db), 'changes');
  const lastInsert = await get('SELECT last_insert_rowid() AS lastInsertRowId;', []);
  return {
    changes,
    lastInsertRowId: safeInteger(lastInsert?.['lastInsertRowId'] ?? 0, 'lastInsertRowId'),
  };
}

async function get(
  sql: string,
  parameters: readonly SqliteParameter[],
): Promise<Record<string, unknown> | undefined> {
  return (await query(sql, parameters))[0];
}

async function all(
  sql: string,
  parameters: readonly SqliteParameter[],
): Promise<Record<string, unknown>[]> {
  return await query(sql, parameters);
}

async function query(
  sql: string,
  parameters: readonly SqliteParameter[],
): Promise<Record<string, unknown>[]> {
  const result = await requireSqlite().execWithParams(requireDatabase(), sql, [...parameters]);
  return result.rows.map((row) =>
    Object.fromEntries(
      result.columns.map((column, index) => {
        const value: unknown = row[index];
        return [column, value instanceof Uint8Array ? Uint8Array.from(value) : value];
      }),
    ),
  );
}

function exportDatabase(): ArrayBuffer {
  return exportBytes().buffer;
}

async function beginImport(bytes: ArrayBuffer): Promise<void> {
  if (transactionActive) {
    throw workerError('database_busy', 'The database is transaction-bound.');
  }
  const backup = exportBytes();
  await writeSnapshot(recoverySnapshotKey(), backup);
  try {
    await openDatabase(new Uint8Array(bytes));
    await assertDatabaseReadable();
  } catch (error) {
    await openDatabase(backup);
    await deleteSnapshot(recoverySnapshotKey());
    throw workerError(
      'database_corrupt',
      error instanceof Error ? error.message : 'The imported database could not be opened.',
    );
  }
}

async function commitImport(): Promise<void> {
  const candidate = exportBytes();
  try {
    await writeAndDeleteSnapshots(activeSnapshotKey(), candidate, recoverySnapshotKey());
  } catch (error) {
    await rollbackImport();
    throw workerError(
      'database_operation_failed',
      'The imported database could not be saved.',
      error,
    );
  }
}

async function rollbackImport(): Promise<void> {
  const recovery = await readSnapshot(recoverySnapshotKey());
  if (recovery !== undefined) await openDatabase(recovery);
  await deleteSnapshot(recoverySnapshotKey());
}

async function restoreInterruptedImport(): Promise<void> {
  const recovery = await readSnapshot(recoverySnapshotKey());
  if (recovery === undefined) return;
  await writeAndDeleteSnapshots(activeSnapshotKey(), recovery, recoverySnapshotKey());
}

async function openDatabase(bytes?: Uint8Array, ownedInitialSnapshot = false): Promise<void> {
  await closeDatabase();
  const vfs = requireMemoryVfs();
  vfs.mapNameToFile.delete(activeDatabaseName);
  if (bytes !== undefined && bytes.byteLength > 0) {
    vfs.mapNameToFile.set(activeDatabaseName, {
      name: activeDatabaseName,
      flags: openFlags,
      size: bytes.byteLength,
      data: ownedInitialSnapshot ? exactSnapshotBuffer(bytes) : Uint8Array.from(bytes).buffer,
    } satisfies MemoryFile);
  }
  database = await requireSqlite().open_v2(activeDatabaseName, openFlags, vfs.name);
  const api = requireSqlite();
  api.create_function(
    database,
    'yelaxis_search_normalize',
    1,
    SQLite.SQLITE_UTF8 | SQLite.SQLITE_DETERMINISTIC,
    0,
    (context, values) =>
      api.result_text(context, normalizeSearchText(api.value_text(values[0] ?? 0))),
  );
  await requireSqlite().exec(
    database,
    'PRAGMA foreign_keys = ON; PRAGMA journal_mode = MEMORY; PRAGMA synchronous = FULL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -8192;',
  );
}

async function assertDatabaseReadable(): Promise<void> {
  const row = await get('PRAGMA integrity_check;', []);
  if (row?.['integrity_check'] !== 'ok') {
    throw workerError('database_corrupt', 'The SQLite snapshot did not pass integrity_check.');
  }
}

async function checkedHealth(policy: string | undefined): Promise<DatabaseHealth> {
  if (transactionActive) throw workerError('database_busy', 'A database transaction is active.');
  if (typeof policy !== 'string' || !/^[a-f0-9]{40}$/u.test(policy))
    throw workerError('invalid_request', 'A release health policy is required.');
  // The worker queue and exclusive database lock keep these exact bytes stable across validation.
  // Hashing never asserts authorization, authenticity against same-origin code, or encryption.
  let proof: Awaited<ReturnType<typeof imageHealthProof>> | undefined;
  try {
    proof = await imageHealthProof(
      currentFileBytes() as Uint8Array<ArrayBuffer>,
      policy,
      requireSqlite().libversion(),
    );
    const transaction = requireSnapshotDatabase().transaction(healthStoreName, 'readonly');
    const completed = transactionComplete(transaction);
    const [stored] = await Promise.all([
      requestResult<unknown>(transaction.objectStore(healthStoreName).get(activeSnapshotKey())),
      completed,
    ]);
    if (matchesHealthProof(stored, proof))
      return { integrityCheck: 'ok', foreignKeyViolations: [], verification: 'identical-image' };
  } catch {
    // Optional metadata/storage/crypto failures require the normal full checks, never a false pass.
  }
  const integrity = await get('PRAGMA integrity_check;', []);
  const foreignKeyViolations = (await all(
    'PRAGMA foreign_key_check;',
    [],
  )) as ForeignKeyViolation[];
  const health = {
    integrityCheck:
      typeof integrity?.['integrity_check'] === 'string'
        ? integrity['integrity_check']
        : 'missing_result',
    foreignKeyViolations,
    verification: 'full' as const,
  };
  if (health.integrityCheck === 'ok' && foreignKeyViolations.length === 0 && proof !== undefined) {
    try {
      const transaction = requireSnapshotDatabase().transaction(healthStoreName, 'readwrite');
      transaction.objectStore(healthStoreName).put(proof, activeSnapshotKey());
      await transactionComplete(transaction);
    } catch {
      // A cache write is optional. The full result passed; data and acknowledged writes are intact.
    }
  }
  return health;
}

async function closeDatabase(): Promise<void> {
  if (database === undefined || sqlite === undefined) return;
  const closing = database;
  database = undefined;
  await sqlite.close(closing);
  requireMemoryVfs().retireClosedFiles();
}

async function close(): Promise<void> {
  await closeDatabase();
  snapshotDatabase?.close();
  snapshotDatabase = undefined;
  if (transactionSnapshot !== undefined) retireBeforeImage(transactionSnapshot);
  transactionSnapshot = undefined;
  transactionActive = false;
  releaseDatabaseLock?.();
  releaseDatabaseLock = undefined;
}

/**
 * Removes this database and its interrupted-import recovery copy from browser storage, then closes
 * and releases its Web Lock. Only the tab that holds the lock can do this, so a database another tab
 * has open is never removed under it. Other databases are untouched.
 */
async function destroy(): Promise<void> {
  if (transactionActive) {
    throw workerError('database_busy', 'The database is transaction-bound.');
  }
  requireDatabase();
  await closeDatabase();
  requireMemoryVfs().mapNameToFile.delete(activeDatabaseName);
  const transaction = requireSnapshotDatabase().transaction(
    [snapshotStoreName, healthStoreName],
    'readwrite',
  );
  const store = transaction.objectStore(snapshotStoreName);
  store.delete(activeSnapshotKey());
  store.delete(recoverySnapshotKey());
  transaction.objectStore(healthStoreName).delete(activeSnapshotKey());
  await transactionComplete(transaction);
  await close();
}

function requireDatabase(): number {
  if (database === undefined) {
    throw workerError('database_closed', 'The browser database is closed.');
  }
  return database;
}

function requireSqlite(): SQLiteAPI {
  if (sqlite === undefined) {
    throw workerError('storage_unavailable', 'The SQLite engine is unavailable.');
  }
  return sqlite;
}

function requireMemoryVfs(): BoundedMemoryVFS {
  if (memoryVfs === undefined) {
    throw workerError('storage_unavailable', 'The in-worker SQLite filesystem is unavailable.');
  }
  return memoryVfs;
}

function currentFileBytes(): Uint8Array {
  const file = requireMemoryVfs().mapNameToFile.get(activeDatabaseName) as MemoryFile | undefined;
  if (file === undefined) {
    throw workerError('database_operation_failed', 'The SQLite database file is unavailable.');
  }
  return new Uint8Array(file.data, 0, file.size);
}

function exportBytes(): Uint8Array<ArrayBuffer> {
  return currentFileBytes().slice();
}

async function persistActiveSnapshot(): Promise<void> {
  // Compress the stable exact view before opening IndexedDB's atomic transaction.
  // The serial worker queue owns it until durable acknowledgment; no SQL can change it meanwhile.
  await writeSnapshot(activeSnapshotKey(), currentFileBytes());
}

function activeSnapshotKey(): string {
  return `active:${activeDatabaseName}`;
}

function recoverySnapshotKey(): string {
  return `recovery:${activeDatabaseName}`;
}

async function openSnapshotDatabase(): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(snapshotDatabaseName, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(snapshotStoreName)) {
        request.result.createObjectStore(snapshotStoreName);
      }
      if (!request.result.objectStoreNames.contains(healthStoreName)) {
        request.result.createObjectStore(healthStoreName);
      }
    };
    request.onerror = () => reject(indexedDbError(request.error, 'IndexedDB could not open.'));
    request.onblocked = () =>
      reject(workerError('database_busy', 'Browser storage is blocked by another tab.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function readSnapshot(key: string): Promise<Uint8Array | undefined> {
  const transaction = requireSnapshotDatabase().transaction(snapshotStoreName, 'readonly');
  const completed = transactionComplete(transaction);
  const request = transaction.objectStore(snapshotStoreName).get(key);
  const value = await requestResult<unknown>(request);
  await completed;
  try {
    return await decodeSnapshotValue(value);
  } catch (error) {
    throw workerError(
      'database_corrupt',
      'The stored database snapshot has an invalid format.',
      error,
    );
  }
}

async function writeSnapshot(key: string, bytes: Uint8Array): Promise<void> {
  const value = await encodeSnapshotValue(bytes);
  const transaction = requireSnapshotDatabase().transaction(snapshotStoreName, 'readwrite');
  transaction.objectStore(snapshotStoreName).put(value, key);
  await transactionComplete(transaction);
}

async function deleteSnapshot(key: string): Promise<void> {
  const transaction = requireSnapshotDatabase().transaction(snapshotStoreName, 'readwrite');
  transaction.objectStore(snapshotStoreName).delete(key);
  await transactionComplete(transaction);
}

async function writeAndDeleteSnapshots(
  writeKey: string,
  bytes: Uint8Array,
  deleteKey: string,
): Promise<void> {
  const value = await encodeSnapshotValue(bytes);
  const transaction = requireSnapshotDatabase().transaction(snapshotStoreName, 'readwrite');
  const store = transaction.objectStore(snapshotStoreName);
  store.put(value, writeKey);
  store.delete(deleteKey);
  await transactionComplete(transaction);
}

function requireSnapshotDatabase(): IDBDatabase {
  if (snapshotDatabase === undefined) {
    throw workerError('storage_unavailable', 'Browser snapshot storage is unavailable.');
  }
  return snapshotDatabase;
}

async function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return await new Promise<Result>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(indexedDbError(request.error, 'The IndexedDB request failed.'));
  });
}

async function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(indexedDbError(transaction.error, 'The IndexedDB transaction was aborted.'));
    transaction.onerror = () =>
      reject(indexedDbError(transaction.error, 'The IndexedDB transaction failed.'));
  });
}

function indexedDbError(error: DOMException | null, fallback: string): Error {
  return error ?? new Error(fallback);
}

function transactionControl(sql: string): 'begin' | 'commit' | 'rollback' | null {
  const normalized = sql.trim().replace(/;+$/u, '').trim().toUpperCase();
  if (/^BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?$/u.test(normalized)) return 'begin';
  if (normalized === 'COMMIT' || normalized === 'END') return 'commit';
  if (normalized === 'ROLLBACK') return 'rollback';
  return null;
}

function requireSql(request: BrowserSqliteRequest): string {
  if (typeof request.sql !== 'string' || request.sql.trim().length === 0) {
    throw workerError('invalid_request', 'A non-empty SQL statement is required.');
  }
  return request.sql;
}

function requireBytes(request: BrowserSqliteRequest): ArrayBuffer {
  if (!(request.bytes instanceof ArrayBuffer) || request.bytes.byteLength === 0) {
    throw workerError('invalid_request', 'A non-empty database file is required.');
  }
  return request.bytes;
}

/** The MemoryVFS allows 64-character paths; SQLite needs the name plus `-journal` to fit. */
const maximumDatabaseNameLength = 56;

function normalizeDatabaseName(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length > maximumDatabaseNameLength ||
    !/^\/[A-Za-z0-9._-]+\.sqlite3$/u.test(trimmed)
  ) {
    throw workerError('invalid_request', 'The database name is not valid.');
  }
  return trimmed;
}

function safeInteger(value: unknown, field: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric)) {
    throw workerError(
      'database_operation_failed',
      `${field} exceeded the JavaScript safe integer range.`,
    );
  }
  return numeric;
}

type WorkerError = Error & { readonly code: BrowserSqliteWorkerErrorCode };

function workerError(
  code: BrowserSqliteWorkerErrorCode,
  message: string,
  cause?: unknown,
): WorkerError {
  return Object.assign(new Error(message, { cause }), { code });
}

function isWorkerError(value: unknown): value is WorkerError {
  return value instanceof Error && 'code' in value && typeof value.code === 'string';
}

function normalizeError(error: unknown): {
  code: BrowserSqliteWorkerErrorCode;
  message: string;
} {
  if (error instanceof Error) {
    const code =
      'code' in error && typeof error.code === 'string'
        ? (error.code as BrowserSqliteWorkerErrorCode)
        : 'database_operation_failed';
    return { code, message: error.message };
  }
  return { code: 'database_operation_failed', message: 'The database operation failed.' };
}
