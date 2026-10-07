import assert from 'node:assert/strict';
import test from 'node:test';
import { queryDatabase } from '../../apps/web/scripts/lib/account-stack.mjs';

const environment = { binary: '/synthetic/supabase', workdir: '/synthetic-stack' };
const query = 'SELECT 1 AS verification';

function options(result) {
  return {
    readEnvironment: () => environment,
    execute(binary, args, settings) {
      assert.equal(binary, environment.binary);
      assert.deepEqual(args, [
        'db',
        'query',
        '--local',
        '--workdir',
        environment.workdir,
        '--output-format',
        'json',
        '--agent',
        'no',
        query,
      ]);
      assert.equal(settings.encoding, 'utf8');
      assert.equal(settings.timeout, 120_000);
      return result;
    },
  };
}

test('browser account queries preserve CLI row arrays, envelopes and genuine empty results', () => {
  const rows = [{ verification: 1, rls: true, owner: 'synthetic' }];
  for (const value of [rows, { rows }, [], { rows: [] }]) {
    const expected = Array.isArray(value) ? value : value.rows;
    assert.deepEqual(
      queryDatabase(query, options({ status: 0, stdout: JSON.stringify(value) })),
      expected,
    );
  }
});

test('browser account queries reject malformed output rather than treating it as an empty database', () => {
  for (const stdout of ['synthetic private material', '{"data":[]}', '[null]', '{"rows":[1]}'])
    assert.throws(() => queryDatabase(query, options({ status: 0, stdout })), {
      message: 'The local catalog query returned an unsupported result format.',
    });
});

test('failed browser account queries never echo CLI output', () => {
  assert.throws(
    () =>
      queryDatabase(
        query,
        options({ status: 1, stdout: 'synthetic private material', stderr: 'synthetic password' }),
      ),
    { message: 'A database query on the local stack failed.' },
  );
});
