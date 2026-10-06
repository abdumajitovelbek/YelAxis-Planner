import type { SqliteDriver } from './driver';

export type ForeignKeyViolation = Readonly<{
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}>;

export type DatabaseHealth = Readonly<{
  integrityCheck: string;
  foreignKeyViolations: readonly ForeignKeyViolation[];
  /** Internal verification provenance; never planning state or an authorization claim. */
  verification?: 'full' | 'identical-image';
}>;

export async function checkDatabaseHealth(
  driver: SqliteDriver,
  options: { readonly cachePolicy?: string | undefined } = {},
): Promise<DatabaseHealth> {
  if (
    options.cachePolicy !== undefined &&
    /^[a-f0-9]{40}$/u.test(options.cachePolicy) &&
    driver.checkedHealth !== undefined
  )
    return await driver.checkedHealth(options.cachePolicy);
  const integrity = await driver.get<{ integrity_check: string }>('PRAGMA integrity_check;');
  const foreignKeyViolations = await driver.all<ForeignKeyViolation>('PRAGMA foreign_key_check;');

  return {
    integrityCheck: integrity?.integrity_check ?? 'missing_result',
    foreignKeyViolations,
  };
}
