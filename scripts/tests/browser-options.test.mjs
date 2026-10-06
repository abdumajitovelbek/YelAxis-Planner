import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { chromiumExecutableOptions } from '../../apps/web/scripts/lib/browser.mjs';

test('browser verification defaults to the version managed by Playwright', () => {
  assert.deepEqual(chromiumExecutableOptions({}), {});
});

test('a deliberate browser override must use an absolute path', () => {
  const path = resolve('browser with spaces');
  assert.deepEqual(chromiumExecutableOptions({ CHROMIUM_EXECUTABLE_PATH: path }), {
    executablePath: path,
  });
  assert.throws(() => chromiumExecutableOptions({ CHROMIUM_EXECUTABLE_PATH: './browser' }));
});
