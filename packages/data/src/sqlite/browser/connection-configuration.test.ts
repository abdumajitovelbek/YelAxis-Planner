import { expect, it } from 'vitest';
import { isConnectionConfiguration } from './connection-configuration';

it('never treats persistent pragmas, disabled integrity or concatenated SQL as connection-only', () => {
  expect(isConnectionConfiguration(' PRAGMA foreign_keys = ON; ')).toBe(true);
  for (const sql of [
    'PRAGMA foreign_keys = OFF;',
    'PRAGMA user_version = 19;',
    'PRAGMA foreign_keys = ON; DELETE FROM actions;',
    'CREATE TABLE example(id);',
  ]) {
    expect(isConnectionConfiguration(sql)).toBe(false);
  }
});
