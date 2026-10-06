import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkReleaseSources, checkReleaseArtifact } from '../check-release.mjs';
import { cloudflareHeaders } from '../../apps/web/scripts/lib/release-config.mjs';

test('release boundary finds outward imports and production logging without echoing source', () => {
  const root = mkdtempSync(join(tmpdir(), 'yelaxis-release-policy-'));
  try {
    const path = join(root, 'packages/domain/src/example.ts');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `import { x } from '@yelaxis/data'; console.error('synthetic-private-data');`,
    );
    const result = checkReleaseSources(root);
    assert.deepEqual(
      result.findings.map((f) => f.rule),
      ['outward-import', 'runtime-log-or-telemetry'],
    );
    assert.ok(!JSON.stringify(result).includes('synthetic-private-data'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact preflight rejects debug files and identity-bearing tokens, reports only digests', () => {
  const root = mkdtempSync(join(tmpdir(), 'yelaxis-release-artifact-'));
  try {
    for (const name of ['index.html', 'sw.js', 'manifest.webmanifest'])
      writeFileSync(join(root, name), 'synthetic static shell');
    writeFileSync(join(root, '_headers'), cloudflareHeaders({ apiOrigin: null }));
    assert.equal(checkReleaseArtifact(root).files.length, 4);
    writeFileSync(join(root, 'debug.map'), '{}');
    assert.throws(() => checkReleaseArtifact(root), /private_or_debug_file/);
    rmSync(join(root, 'debug.map'));
    const token = [
      Buffer.from('{"alg":"HS256"}').toString('base64url'),
      Buffer.from('{"role":"authenticated","sub":"synthetic"}').toString('base64url'),
      'synthetic-signature',
    ].join('.');
    writeFileSync(join(root, 'index.html'), token);
    assert.throws(() => checkReleaseArtifact(root), /private_credential_pattern/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
