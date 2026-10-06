import type { SqliteDriver } from '../driver';
import { containsTopLevelTransactionControl } from './migration-sql';

export type MigrationSource = Readonly<{
  version: number;
  name: string;
  sql: string;
  checksum: string;
}>;

export type MigrationErrorCode =
  | 'invalid_migration_set'
  | 'migration_history_mismatch'
  | 'migration_checksum_mismatch'
  | 'database_version_too_new'
  | 'foreign_key_check_failed'
  | 'migration_apply_failed';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
    this.code = code;
  }
}

export function checksumMigrationSql(sql: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of sql.replaceAll('\r\n', '\n')) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export function defineMigration(version: number, name: string, sql: string): MigrationSource {
  return Object.freeze({ version, name, sql, checksum: checksumMigrationSql(sql) });
}

type AppliedMigrationRow = {
  version: number;
  name: string;
  checksum: string;
};

type PragmaNumberRow = Record<string, number>;

function validateMigrationSet(migrations: readonly MigrationSource[]): void {
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (
      migration.version !== expectedVersion ||
      !/^[a-z][a-z0-9_]*$/.test(migration.name) ||
      migration.sql.trim().length === 0 ||
      containsTopLevelTransactionControl(migration.sql) ||
      migration.checksum !== checksumMigrationSql(migration.sql)
    ) {
      throw new MigrationError(
        'invalid_migration_set',
        `Migration ${String(migration.version)} is not a valid immutable ordered source`,
      );
    }
  }
}

async function readPragmaNumber(driver: SqliteDriver, pragma: string): Promise<number> {
  const row = await driver.get<PragmaNumberRow>(`PRAGMA ${pragma};`);
  const value = row?.[pragma];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MigrationError('migration_history_mismatch', `PRAGMA ${pragma} was not an integer`);
  }
  return value;
}

async function assertForeignKeysEnabled(driver: SqliteDriver): Promise<void> {
  const enabled = await readPragmaNumber(driver, 'foreign_keys');
  if (enabled !== 1) {
    throw new MigrationError(
      'foreign_key_check_failed',
      'SQLite foreign key enforcement could not be enabled',
    );
  }
}

async function ensureMigrationLedger(driver: SqliteDriver): Promise<void> {
  await driver.executeScript(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
}

async function migrationLedgerExists(driver: SqliteDriver): Promise<boolean> {
  const row = await driver.get<{ readonly count: number }>(
    `SELECT COUNT(*) AS count
     FROM sqlite_master
     WHERE type = 'table' AND name = '_schema_migrations';`,
  );
  return row?.count === 1;
}

async function verifyHistory(
  driver: SqliteDriver,
  migrations: readonly MigrationSource[],
): Promise<number> {
  const userVersion = await readPragmaNumber(driver, 'user_version');
  const latestVersion = migrations.at(-1)?.version ?? 0;
  if (userVersion > latestVersion) {
    throw new MigrationError(
      'database_version_too_new',
      `Database version ${String(userVersion)} is newer than supported version ${String(latestVersion)}`,
    );
  }

  const applied = await driver.all<AppliedMigrationRow>(
    'SELECT version, name, checksum FROM _schema_migrations ORDER BY version ASC;',
  );
  const highestApplied = applied.at(-1)?.version ?? 0;
  if (highestApplied !== userVersion || applied.length !== userVersion) {
    throw new MigrationError(
      'migration_history_mismatch',
      'SQLite user_version and the migration ledger do not agree',
    );
  }

  for (const row of applied) {
    const source = migrations[row.version - 1];
    if (!source || source.name !== row.name) {
      throw new MigrationError(
        'migration_history_mismatch',
        `Applied migration ${String(row.version)} is not present in this build`,
      );
    }
    if (source.checksum !== row.checksum) {
      throw new MigrationError(
        'migration_checksum_mismatch',
        `Applied migration ${String(row.version)} no longer matches its source`,
      );
    }
  }

  return userVersion;
}

export type MigrationResult = Readonly<{
  fromVersion: number;
  toVersion: number;
  appliedVersions: readonly number[];
}>;

export async function runMigrations(
  driver: SqliteDriver,
  migrations: readonly MigrationSource[],
  appliedAt: () => string,
): Promise<MigrationResult> {
  validateMigrationSet(migrations);
  await driver.executeScript('PRAGMA foreign_keys = ON;');
  await assertForeignKeysEnabled(driver);
  const preflightVersion = await readPragmaNumber(driver, 'user_version');
  const latestVersion = migrations.at(-1)?.version ?? 0;
  if (preflightVersion > latestVersion) {
    throw new MigrationError(
      'database_version_too_new',
      `Database version ${String(preflightVersion)} is newer than supported version ${String(latestVersion)}`,
    );
  }
  const hasMigrationLedger = await migrationLedgerExists(driver);
  if (preflightVersion > 0 && !hasMigrationLedger) {
    throw new MigrationError(
      'migration_history_mismatch',
      'A versioned database is missing its migration ledger',
    );
  }
  if (!hasMigrationLedger) await ensureMigrationLedger(driver);
  const fromVersion = await verifyHistory(driver, migrations);
  const appliedVersions: number[] = [];

  for (const migration of migrations.slice(fromVersion)) {
    try {
      await driver.migrationTransaction(async (transaction) => {
        await transaction.executeScript(migration.sql);
        const violations = await transaction.all<object>('PRAGMA foreign_key_check;');
        if (violations.length > 0) {
          throw new MigrationError(
            'foreign_key_check_failed',
            `Migration ${String(migration.version)} introduced a foreign key violation`,
          );
        }
        await transaction.run(
          `INSERT INTO _schema_migrations (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?);`,
          [migration.version, migration.name, migration.checksum, appliedAt()],
        );
        await transaction.executeScript(`PRAGMA user_version = ${String(migration.version)};`);
      });
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw new MigrationError(
        'migration_apply_failed',
        `Migration ${String(migration.version)} (${migration.name}) failed`,
        { cause: error },
      );
    }
    appliedVersions.push(migration.version);
  }

  return {
    fromVersion,
    toVersion: migrations.at(-1)?.version ?? 0,
    appliedVersions,
  };
}
