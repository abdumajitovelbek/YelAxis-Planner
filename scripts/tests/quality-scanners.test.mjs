import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { formatSecretFindings, scanSecrets } from '../scan-secrets.mjs';
import { checkProductBoundary, formatBoundaryFindings } from '../check-product-boundary.mjs';

function withTemporaryRepository(run) {
  const root = mkdtempSync(join(tmpdir(), 'yelaxis-quality-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeFixture(root, relativePath, contents) {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

test('secret scanner accepts empty and explicit placeholder assignments', () => {
  withTemporaryRepository((root) => {
    writeFixture(
      root,
      '.env.example',
      ['SUPABASE_SERVICE_ROLE_KEY=', 'OPENAI_API_KEY=<replace-me>', 'GITHUB_TOKEN=${TOKEN}'].join(
        '\n',
      ),
    );

    assert.deepEqual(scanSecrets({ root }), []);
  });
});

test('secret scanner reports rule and path without exposing a synthetic matched value', () => {
  withTemporaryRepository((root) => {
    const syntheticValue = ['sk', 'proj', 'synthetic', 'x'.repeat(32)].join('-');
    writeFixture(root, 'unsafe.txt', `value=${syntheticValue}\n`);

    const findings = scanSecrets({ root });
    const output = formatSecretFindings(findings);

    assert.equal(
      findings.some((finding) => finding.ruleId === 'openai-style-key'),
      true,
    );
    assert.match(output, /unsafe\.txt \[openai-style-key\]/);
    assert.equal(output.includes(syntheticValue), false);
  });
});

test('manual planning boundary permits domain contracts but blocks provider dependencies', () => {
  withTemporaryRepository((root) => {
    const providerDependency = ['open', 'ai'].join('');
    writeFixture(
      root,
      'packages/domain/src/contracts.ts',
      'export interface ActionTitle { text: string }\n',
    );
    writeFixture(
      root,
      'package.json',
      JSON.stringify({ private: true, dependencies: { [providerDependency]: '0.0.0' } }),
    );

    const findings = checkProductBoundary({ root });

    assert.deepEqual(
      findings.map((finding) => finding.ruleId),
      ['model-sdk-dependency'],
    );
    assert.match(formatBoundaryFindings(findings), /model-sdk-dependency/);
  });
});

test('manual planning boundary blocks AI wording in app runtime source but ignores test fixtures', () => {
  withTemporaryRepository((root) => {
    const prohibitedLabel = ['AI', 'assistant'].join(' ');
    const source = `export const label = ${JSON.stringify(prohibitedLabel)};\n`;
    writeFixture(root, 'apps/web/src/app.tsx', source);
    writeFixture(root, 'apps/web/src/app.test.tsx', source);

    const findings = checkProductBoundary({ root });

    assert.deepEqual(findings, [
      {
        relativePath: 'apps/web/src/app.tsx',
        ruleId: 'visible-ai-or-provider-wording',
      },
    ]);
  });
});

test('manual planning boundary allows the input-purpose attribute but still blocks automatic wording', () => {
  withTemporaryRepository((root) => {
    writeFixture(
      root,
      'apps/web/src/sign-in.tsx',
      'export const field = <input autoComplete="current-password" />;\n',
    );
    writeFixture(
      root,
      'apps/web/src/sign-in-options.ts',
      "export const options = { autocomplete: 'off' };\n",
    );
    writeFixture(
      root,
      'apps/web/src/promise.ts',
      "export const copy = 'We autoComplete your week for you.';\n",
    );

    const findings = checkProductBoundary({ root });

    assert.deepEqual(findings, [
      { relativePath: 'apps/web/src/promise.ts', ruleId: 'automatic-planning-wording' },
    ]);
  });
});
