import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeSqliteDriver } from './node-driver.node';

const temporaryDirectories: string[] = [];

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yelaxis-driver-'));
  temporaryDirectories.push(directory);
  return join(directory, 'driver.sqlite');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('NodeSqliteDriver transaction admission', () => {
  it('keeps a scheduled public write outside a later rolled-back transaction', async () => {
    const driver = new NodeSqliteDriver(await temporaryDatabasePath());
    await driver.executeScript('CREATE TABLE records (value TEXT NOT NULL) STRICT;');

    const standalone = driver.run('INSERT INTO records (value) VALUES (?);', ['standalone-a']);
    const concurrent = driver.run('INSERT INTO records (value) VALUES (?);', ['standalone-b']);
    await expect(driver.transaction(() => Promise.resolve(undefined))).rejects.toThrow(
      'transaction unavailable',
    );
    await expect(Promise.all([standalone, concurrent])).resolves.toEqual([
      expect.objectContaining({ changes: 1 }),
      expect.objectContaining({ changes: 1 }),
    ]);

    await expect(
      driver.transaction(async (transaction) => {
        await transaction.run('INSERT INTO records (value) VALUES (?);', ['rolled-back']);
        throw new Error('synthetic rollback');
      }),
    ).rejects.toThrow('synthetic rollback');
    await expect(
      driver.all<{ value: string }>('SELECT value FROM records ORDER BY rowid;'),
    ).resolves.toEqual([{ value: 'standalone-a' }, { value: 'standalone-b' }]);
    await driver.close();
  });

  it('clears transaction state when BEGIN fails on another connection lock', async () => {
    const path = await temporaryDatabasePath();
    const first = new NodeSqliteDriver(path, { busyTimeoutMs: 25 });
    const second = new NodeSqliteDriver(path, { busyTimeoutMs: 25 });
    await first.executeScript('CREATE TABLE records (value TEXT NOT NULL) STRICT;');

    await first.transaction(async (transaction) => {
      await transaction.run('INSERT INTO records (value) VALUES (?);', ['first']);
      await expect(second.transaction(() => Promise.resolve(undefined))).rejects.toThrow();
    });

    await second.transaction(async (transaction) => {
      await transaction.run('INSERT INTO records (value) VALUES (?);', ['second']);
    });
    await expect(
      second.all<{ value: string }>('SELECT value FROM records ORDER BY rowid;'),
    ).resolves.toEqual([{ value: 'first' }, { value: 'second' }]);
    await first.close();
    await second.close();
  });

  it('keeps transaction control adapter-owned and rolls back the scoped write', async () => {
    const driver = new NodeSqliteDriver(await temporaryDatabasePath());
    await driver.executeScript('CREATE TABLE records (value TEXT NOT NULL) STRICT;');

    await expect(
      driver.transaction(async (transaction) => {
        expect('executeScript' in transaction).toBe(false);
        await transaction.run('INSERT INTO records (value) VALUES (?);', ['rolled-back']);
        await transaction.run('/* application */ COMMIT;');
      }),
    ).rejects.toThrow('transaction control is adapter-owned');
    await expect(
      driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM records;'),
    ).resolves.toEqual({ count: 0 });
    await driver.close();
  });
});
