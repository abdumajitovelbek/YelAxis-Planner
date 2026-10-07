import { spawnSync } from 'node:child_process';
import { selectLocalTestStack } from '../../scripts/lib/local-test-stack.mjs';
import {
  catalogQueryArguments,
  parseCatalogRows,
} from '../../packages/sync/src/testing/catalog-query.ts';

const { binary, workdir } = selectLocalTestStack(process.cwd());
const result = spawnSync(binary, catalogQueryArguments(workdir, 'SELECT 1 AS verification'), {
  encoding: 'utf8',
  timeout: 120_000,
});
if (result.status !== 0) {
  // Report only predefined words, never raw CLI output, connection strings or credentials.
  const text = String(result.stderr).toLowerCase();
  const categories = [
    'psql',
    'not found',
    'unknown command',
    'unknown flag',
    'connection',
    'refused',
    'timeout',
    'tls',
    'ssl',
    'certificate',
    'permission',
    'docker',
    'syntax',
    'experimental',
    'confirm',
    'interactive',
  ].filter((word) => text.includes(word));
  throw new Error(
    `Local catalog query failed: ${JSON.stringify({ exit: result.status, categories })}`,
  );
}
const rows = parseCatalogRows(result.stdout);
if (rows.length !== 1 || rows[0]?.verification !== 1)
  throw new Error('Local catalog query format is incompatible.');
console.log('Local catalog query returned the expected typed row.');
