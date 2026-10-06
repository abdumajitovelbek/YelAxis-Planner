import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStaticCacheUrl } from '../../apps/web/scripts/lib/cache-policy.mjs';

test('static cache policy accepts opaque asset hashes and refuses plan/API/backup/auth data', () => {
  const origin = 'https://example.test';
  assert.equal(isStaticCacheUrl(`${origin}/assets/sqlite-worker-DAPiuJsu.js`, origin), true);
  assert.equal(isStaticCacheUrl(`${origin}/index.html?__WB_REVISION__=static`, origin), true);
  assert.equal(isStaticCacheUrl(`${origin}/icons/axis/standard.png`, origin), true);
  for (const path of [
    '/api/records.json',
    '/auth/session.json',
    '/token.json',
    '/backup.json',
    '/import.json',
    '/assets/a.js?token=private',
    '/data',
    '/assets/owned-id.js',
  ]) {
    assert.equal(isStaticCacheUrl(`${origin}${path}`, origin, ['owned-id']), false, path);
  }
  assert.equal(isStaticCacheUrl('https://foreign.test/assets/app.js', origin), false);
});
