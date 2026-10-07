import { spawnSync } from 'node:child_process';
import { selectLocalTestStack } from '../../scripts/lib/local-test-stack.mjs';

const { binary, workdir } = selectLocalTestStack(process.cwd());
const result = spawnSync(
  binary,
  [
    'db',
    'query',
    '--local',
    '--workdir',
    workdir,
    '--output-format',
    'json',
    '--agent',
    'no',
    'SELECT 1 AS verification',
  ],
  { encoding: 'utf8', timeout: 120_000 },
);
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
const output = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
console.log(
  JSON.stringify({
    catalogProbe: 'succeeded',
    fields: Object.keys(output),
    rowsIsArray: Array.isArray(output.rows),
    rowCount: Array.isArray(output.rows) ? output.rows.length : null,
    firstRowFields:
      output.rows?.[0] && typeof output.rows[0] === 'object' ? Object.keys(output.rows[0]) : null,
    verifiesOne: output.rows?.[0]?.verification === 1,
  }),
);
if (output.rows?.[0]?.verification !== 1)
  throw new Error('Local catalog query format is incompatible.');
