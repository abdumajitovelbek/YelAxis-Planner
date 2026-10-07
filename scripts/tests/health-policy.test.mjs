import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { releaseHealthPolicy } from '../lib/health-policy.mjs';

test('an archive build binds validation reuse to actual runtime sources and locked dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'planner-health-policy-'));
  try {
    const src = join(root, 'packages', 'data', 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'synthetic locked dependencies');
    writeFileSync(join(src, 'health.ts'), 'export const policy = 1;');
    const first = releaseHealthPolicy(root);
    assert.match(first, /^[a-f0-9]{40}$/u);
    assert.equal(releaseHealthPolicy(root), first);
    writeFileSync(join(root, 'README.md'), 'changed documentation');
    writeFileSync(join(src, 'health.test.ts'), 'changed test fixtures');
    writeFileSync(join(root, '.env.local'), 'synthetic private configuration');
    assert.equal(releaseHealthPolicy(root), first);
    writeFileSync(join(src, 'health.ts'), 'export const policy = 2;');
    const next = releaseHealthPolicy(root);
    assert.notEqual(next, first);
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'changed dependencies');
    assert.notEqual(releaseHealthPolicy(root), next);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
