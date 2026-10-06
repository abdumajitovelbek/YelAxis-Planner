import { describe, expect, it } from 'vitest';

import type { SqliteDriver, SqliteRunResult } from './driver';
import { SerializedSqliteDriver } from './serialized-driver';

/** Fake single-connection driver that rejects overlapping operations like the browser worker. */
function fakeDriver(log: string[]) {
  let busy = false;
  const perform = async <Result>(label: string, value: Result): Promise<Result> => {
    if (busy) throw new Error(`overlap:${label}`);
    busy = true;
    log.push(`start:${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    log.push(`end:${label}`);
    busy = false;
    if (label.startsWith('fail')) throw new Error(`failed:${label}`);
    return value;
  };
  const result: SqliteRunResult = { changes: 1, lastInsertRowId: 0 };
  const driver: SqliteDriver = {
    run: (sql) => perform(sql, result),
    get: <Row extends object>(sql: string) => perform(sql, { sql } as unknown as Row),
    all: <Row extends object>(sql: string) => perform(sql, [] as Row[]),
    executeScript: (sql) => perform(sql, undefined),
    transaction: (operation) =>
      perform('transaction', undefined).then(() =>
        operation({
          run: () => Promise.resolve(result),
          get: () => Promise.resolve(undefined),
          all: () => Promise.resolve([]),
        }),
      ),
    migrationTransaction: () => Promise.reject(new Error('unused')),
    close: () => Promise.resolve(),
  };
  return driver;
}

describe('SerializedSqliteDriver', () => {
  it('runs concurrent calls one at a time in call order', async () => {
    const log: string[] = [];
    const driver = new SerializedSqliteDriver(fakeDriver(log));

    const results = await Promise.all([
      driver.get<{ sql: string }>('first'),
      driver.run('second'),
      driver.all('third'),
      driver.transaction(() => Promise.resolve('inside')),
      driver.executeScript('fifth'),
    ]);

    expect(results).toEqual([
      { sql: 'first' },
      { changes: 1, lastInsertRowId: 0 },
      [],
      'inside',
      undefined,
    ]);
    expect(log).toEqual([
      'start:first',
      'end:first',
      'start:second',
      'end:second',
      'start:third',
      'end:third',
      'start:transaction',
      'end:transaction',
      'start:fifth',
      'end:fifth',
    ]);
  });

  it('keeps serving later calls after an operation fails', async () => {
    const log: string[] = [];
    const driver = new SerializedSqliteDriver(fakeDriver(log));

    const failing = driver.run('fail-first');
    const later = driver.get<{ sql: string }>('later');

    await expect(failing).rejects.toThrow('failed:fail-first');
    await expect(later).resolves.toEqual({ sql: 'later' });
    expect(log).toEqual(['start:fail-first', 'end:fail-first', 'start:later', 'end:later']);
  });
});
