import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('browser schema bootstrap prevents the eval probe in a fresh module graph and preserves validation', () => {
  const source = `
    import assert from 'node:assert/strict';
    let attempts = 0;
    globalThis.Function = function() { attempts++; throw new Error('synthetic-csp-refusal'); };
    await import('./apps/web/src/release/schema-runtime.ts');
    const { z } = await import('./apps/web/node_modules/zod/index.js');
    const schema = z.strictObject({ title: z.string().max(80) });
    assert.equal(schema.safeParse({title:'synthetic'}).success, true);
    assert.equal(schema.safeParse({title:'synthetic',ownerId:'forged'}).success, false);
    assert.equal(schema.safeParse({title:'x'.repeat(81)}).success, false);
    assert.equal(attempts,0);
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
