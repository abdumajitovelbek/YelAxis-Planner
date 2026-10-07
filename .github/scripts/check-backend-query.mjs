import { spawnSync } from 'node:child_process';
import { selectLocalTestStack } from '../../scripts/lib/local-test-stack.mjs';

const { binary, workdir } = selectLocalTestStack(process.cwd());
const result = spawnSync(
  binary,
  ['db', 'query', '--local', '--workdir', workdir, '-o', 'json', 'SELECT 1 AS verification'],
  { encoding: 'utf8' },
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
console.log('Local catalog query succeeded.');
