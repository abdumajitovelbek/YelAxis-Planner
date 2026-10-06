import {
  checkDatabaseHealth,
  runMigrations,
  schemaMigrations,
  type DatabaseHealth,
} from '@yelaxis/data';
import {
  BrowserSqliteDriver,
  BrowserSqliteError,
  type BrowserStorageStatus,
} from '@yelaxis/data/browser';

export type PlanningDatabase = Readonly<{
  driver: BrowserSqliteDriver;
  health: DatabaseHealth;
  storage: BrowserStorageStatus;
}>;

/**
 * Opens one identity's planning database in its own worker and Web Lock, migrates it, and checks
 * its integrity. Without a name it opens the original local database (account sync keeps its name).
 */
export async function openPlanningDatabase(databaseName?: string): Promise<PlanningDatabase> {
  const { driver, storage } = await BrowserSqliteDriver.open(
    databaseName === undefined ? {} : { databaseName },
  );
  try {
    await runMigrations(driver, schemaMigrations, () => new Date().toISOString());
    const revision: unknown = import.meta.env['VITE_YELAXIS_RELEASE_REVISION'];
    const health = await checkDatabaseHealth(driver, {
      cachePolicy: typeof revision === 'string' ? revision : undefined,
    });
    if (health.integrityCheck !== 'ok' || health.foreignKeyViolations.length > 0) {
      throw new Error('The local planning database did not pass its integrity check.');
    }
    return { driver, health, storage };
  } catch (error) {
    await driver.close();
    throw error;
  }
}

/**
 * Removes one identity's database from this browser (account sync removing an account's copy). It opens
 * the database under its own lock first, so a database open in another tab is never removed. A
 * store this tab just closed can hold its lock for a moment longer, so a busy lock is retried
 * briefly before the removal fails closed.
 */
export async function deletePlanningDatabase(
  databaseName: string,
  options: { readonly attempts?: number; readonly delayMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 4;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { driver } = await BrowserSqliteDriver.open({ databaseName });
      await driver.destroyDatabase();
      return;
    } catch (error) {
      const busy = error instanceof BrowserSqliteError && error.code === 'database_busy';
      if (!busy || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, (options.delayMs ?? 150) * attempt));
    }
  }
}
