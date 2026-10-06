import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { scanSecrets, formatSecretFindings } from '../scan-secrets.mjs';

function token(role) {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ role, iss: 'synthetic-only' })).toString('base64url'),
    Buffer.from('synthetic-signature-only').toString('base64url'),
  ].join('.');
}
function scan(content) {
  const root = mkdtempSync(join(tmpdir(), 'yelaxis-jwt-scan-'));
  try {
    writeFileSync(join(root, 'fixture.txt'), content);
    return scanSecrets({ root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('service-role and authenticated JWTs are caught under renamed assignments without values', () => {
  for (const role of ['service_role', 'authenticated']) {
    const synthetic = token(role);
    const findings = scan('renamed=' + synthetic);
    assert.equal(
      findings.some((x) => x.ruleId === 'private-jwt'),
      true,
    );
    assert.equal(formatSecretFindings(findings).includes(synthetic), false);
  }
});
test('encoded private JWT and renamed encoded secret material are still caught', () => {
  const secret = ['sk', 'proj', 'synthetic', 'x'.repeat(32)].join('-');
  for (const value of [token('service_role'), secret]) {
    const encoded = Buffer.from(value).toString('base64');
    const findings = scan('renamed=' + encoded);
    assert.equal(
      findings.some((x) => x.ruleId === 'encoded-secret'),
      true,
    );
    assert.equal(formatSecretFindings(findings).includes(encoded), false);
    assert.equal(formatSecretFindings(findings).includes(value), false);
  }
});
test('public anon JWT remains public configuration; signing-key assignment is not', () => {
  assert.deepEqual(scan('public=' + token('anon')), []);
  const name = ['JWT', 'SECRET'].join('_');
  assert.equal(
    scan(name + '=synthetic-signing-value').some((x) => x.ruleId === 'sensitive-value-assignment'),
    true,
  );
});
