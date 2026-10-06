import { describe, expect, it } from 'vitest';
import { NodeSqliteDriver } from '../testing/node-driver.node';
import { schemaMigrations } from './index';
import { runMigrations } from './migration';
import { searchMigration } from './015_search';

const at = '2026-10-03T00:00:00.000Z';
const owner = '10000000-0000-4000-8000-000000000001';
const action = '16000000-0000-4000-8000-000000000001';
describe('migration 15: rebuildable local Search', () => {
  it('backfills version 14 without changing canonical rows and removes stale private tokens atomically', async () => {
    const driver = new NodeSqliteDriver(':memory:');
    try {
      await runMigrations(driver, schemaMigrations.slice(0, 14), () => at);
      await driver.run(
        'INSERT INTO planning_identities(id, identity_kind, created_at, updated_at) VALUES (?, ?, ?, ?)',
        [owner, 'local', at, at],
      );
      await driver.run(
        'INSERT INTO actions(id, owner_id, title, note_text, state, sort_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [action, owner, 'CAFÉ—СЛОН', 'Synthetic recovery', 'inbox', 'a', at, at],
      );
      const before = await driver.all('SELECT * FROM actions');
      await runMigrations(driver, [...schemaMigrations.slice(0, 14), searchMigration], () => at);
      expect(await driver.all('SELECT * FROM actions')).toEqual(before);
      expect(
        await driver.all<{ token: string }>('SELECT token FROM search_tokens ORDER BY token'),
      ).toEqual([
        { token: 'café' },
        { token: 'recovery' },
        { token: 'synthetic' },
        { token: 'слон' },
      ]);
      await expect(
        driver.transaction(async (tx) => {
          await tx.run('UPDATE actions SET title = ?, note_text = ? WHERE id = ?', [
            'Replacement',
            null,
            action,
          ]);
          throw new Error('interrupted import');
        }),
      ).rejects.toThrow('interrupted import');
      expect(await driver.all('SELECT * FROM actions')).toEqual(before);
      expect(
        await driver.get('SELECT COUNT(*) AS count FROM search_tokens WHERE token = ?', ['café']),
      ).toEqual({ count: 1 });
      await driver.run('UPDATE actions SET title = ?, note_text = ? WHERE id = ?', [
        'Replacement',
        null,
        action,
      ]);
      expect(await driver.all('SELECT token FROM search_tokens')).toEqual([
        { token: 'replacement' },
      ]);
      await driver.run('UPDATE actions SET deleted_at = ? WHERE id = ?', [at, action]);
      expect(await driver.all('SELECT * FROM search_documents')).toEqual([]);
      expect(await driver.all('SELECT * FROM search_tokens')).toEqual([]);
      await driver.run('UPDATE actions SET deleted_at = NULL WHERE id = ?', [action]);
      expect(await driver.get('SELECT COUNT(*) AS count FROM search_documents')).toEqual({
        count: 1,
      });
      await driver.run('DELETE FROM actions WHERE id = ?', [action]);
      expect(await driver.all('SELECT * FROM search_tokens')).toEqual([]);
      expect(await driver.all('PRAGMA foreign_key_check')).toEqual([]);
      expect(await driver.get('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' });
      expect(
        (await runMigrations(driver, [...schemaMigrations.slice(0, 14), searchMigration], () => at))
          .appliedVersions,
      ).toEqual([]);
    } finally {
      await driver.close();
    }
  });
});
