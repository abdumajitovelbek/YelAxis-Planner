import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readReleaseConfiguration,
  releaseHeaders,
  cloudflareHeaders,
  previewHeaders,
} from '../../apps/web/scripts/lib/release-config.mjs';

const publicKey = ['sb', 'publishable', 'synthetic'.repeat(5)].join('_');
const env = {
  VITE_YELAXIS_SUPABASE_URL: 'https://synthetic-project.supabase.co',
  VITE_YELAXIS_SUPABASE_ANON_KEY: publicKey,
  VITE_YELAXIS_RELEASE_REVISION: 'abcdef0',
};
test('hosted accounts use independent HTTPS/public configuration and remain optional', () => {
  assert.deepEqual(readReleaseConfiguration({}, 'local'), {
    target: 'local',
    apiOrigin: null,
    revision: null,
  });
  assert.deepEqual(readReleaseConfiguration({}, 'hosted'), {
    target: 'hosted',
    apiOrigin: null,
    revision: null,
  });
  assert.throws(
    () =>
      readReleaseConfiguration(
        { ...env, VITE_YELAXIS_SUPABASE_URL: 'http://127.0.0.1:57421' },
        'hosted',
      ),
    /independent_https/,
  );
  for (const url of [
    'https://user:synthetic-private@example.supabase.co',
    'https://example.supabase.co/?token=synthetic-private',
    'http://example.invalid',
  ]) {
    assert.throws(
      () => readReleaseConfiguration({ ...env, VITE_YELAXIS_SUPABASE_URL: url }),
      (e) => e.message === 'public_api_url_invalid' && !e.message.includes('synthetic-private'),
    );
  }
  assert.equal(
    readReleaseConfiguration(env, 'hosted').apiOrigin,
    'https://synthetic-project.supabase.co',
  );
});

test('custom HTTPS backends preserve their exact origin in the built and preview policies', () => {
  for (const url of ['https://accounts.example.test', 'https://planner.example.test:8443/']) {
    const configuration = readReleaseConfiguration(
      { ...env, VITE_YELAXIS_SUPABASE_URL: url },
      'hosted',
    );
    const origin = new URL(url).origin;
    assert.equal(configuration.apiOrigin, origin);
    assert.ok(
      releaseHeaders(configuration)['Content-Security-Policy'].includes(
        `connect-src 'self' ${origin};`,
      ),
    );
    assert.deepEqual(
      previewHeaders(cloudflareHeaders(configuration)),
      releaseHeaders(configuration),
    );
  }
  const key = [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({ role: 'anon', ref: 'provider-project' })).toString('base64url'),
    'synthetic-signature',
  ].join('.');
  assert.equal(
    readReleaseConfiguration(
      {
        ...env,
        VITE_YELAXIS_SUPABASE_URL: 'https://accounts.example.test',
        VITE_YELAXIS_SUPABASE_ANON_KEY: key,
      },
      'hosted',
    ).apiOrigin,
    'https://accounts.example.test',
  );
  assert.throws(
    () => readReleaseConfiguration({ ...env, VITE_YELAXIS_SUPABASE_ANON_KEY: key }),
    /must_be_public/,
  );
});

test('local development permits explicit loopback ports and hosted accounts reject loopback', () => {
  for (const url of ['http://127.0.0.1:57421', 'http://localhost:60123/', 'http://[::1]:60123']) {
    const configuration = readReleaseConfiguration({ ...env, VITE_YELAXIS_SUPABASE_URL: url });
    assert.equal(configuration.apiOrigin, new URL(url).origin);
    assert.deepEqual(
      previewHeaders(cloudflareHeaders(configuration)),
      releaseHeaders(configuration),
    );
    assert.throws(
      () => readReleaseConfiguration({ ...env, VITE_YELAXIS_SUPABASE_URL: url }, 'hosted'),
      /independent_https/,
    );
  }
  assert.throws(
    () =>
      readReleaseConfiguration(
        { ...env, VITE_YELAXIS_SUPABASE_URL: 'https://127.0.0.1:60123' },
        'hosted',
      ),
    /independent_https/,
  );
});

test('malformed, noncanonical and unsafe backend URLs fail without echoing values', () => {
  for (const url of [
    'not a URL',
    'ftp://accounts.example.test',
    'http://accounts.example.test',
    'https://user:synthetic-private@accounts.example.test',
    'https://accounts.example.test/?token=synthetic-private',
    'https://accounts.example.test/#synthetic-private',
    'https://accounts.example.test/?',
    'https://accounts.example.test/#',
    'https://accounts.example.test/rest/v1',
    'https://accounts.example.test/a/..',
    'https://accounts.example.test\\rest',
    'https://accounts.example.test;script-src',
    'https://*.example.test',
    'https://ACCOUNTS.example.test',
    'http://127.0.0.1',
    'http://127.0.0.1.example.test:57421',
  ])
    assert.throws(
      () => readReleaseConfiguration({ ...env, VITE_YELAXIS_SUPABASE_URL: url }),
      (error) =>
        error.message === 'public_api_url_invalid' && !error.message.includes('synthetic-private'),
    );
});
test('privileged/session keys are rejected before bundling and never echoed', () => {
  for (const role of ['service_role', 'authenticated']) {
    const token = [
      Buffer.from('{}').toString('base64url'),
      Buffer.from(JSON.stringify({ role })).toString('base64url'),
      'synthetic-signature',
    ].join('.');
    assert.throws(
      () => readReleaseConfiguration({ ...env, VITE_YELAXIS_SUPABASE_ANON_KEY: token }),
      (e) =>
        e.message === 'browser_key_must_be_public_anonymous_configuration' &&
        !e.message.includes(token),
    );
  }
  assert.throws(
    () =>
      readReleaseConfiguration({
        ...env,
        VITE_YELAXIS_SUPABASE_ANON_KEY: ['sb', 'secret', 'synthetic'.repeat(5)].join('_'),
      }),
    /must_be_public/,
  );
  for (const field of ['sub', 'session_id', 'refresh_token', 'access_token']) {
    const token = [
      Buffer.from('{}').toString('base64url'),
      Buffer.from(JSON.stringify({ role: 'anon', [field]: '' })).toString('base64url'),
      'synthetic-signature',
    ].join('.');
    assert.throws(
      () => readReleaseConfiguration({ ...env, VITE_YELAXIS_SUPABASE_ANON_KEY: token }),
      /must_be_public/,
    );
  }
});
test('CSP permits only the configured backend, WASM and static workers without telemetry', () => {
  const headers = releaseHeaders(readReleaseConfiguration(env, 'hosted'));
  assert.match(
    headers['Content-Security-Policy'],
    /connect-src 'self' https:\/\/synthetic-project\.supabase\.co;/,
  );
  assert.match(headers['Content-Security-Policy'], /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(headers['Content-Security-Policy'], /'unsafe-eval'|report-uri|https:\/\/\*/);
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(cloudflareHeaders(readReleaseConfiguration({})), /Service-Worker-Allowed: \//);
});

test('preview serves the built account policy without build environment or private keys', () => {
  const configuration = readReleaseConfiguration({
    ...env,
    VITE_YELAXIS_SUPABASE_URL: 'http://127.0.0.1:57421',
  });
  const source = cloudflareHeaders(configuration);
  assert.deepEqual(previewHeaders(source), releaseHeaders(configuration));
  assert.match(
    previewHeaders(source)['Content-Security-Policy'],
    /connect-src 'self' http:\/\/127\.0\.0\.1:57421;/,
  );
  assert.equal(
    previewHeaders(source, '/assets/app.js?version=1')['Cache-Control'],
    'public, max-age=31536000, immutable',
  );
  assert.equal(previewHeaders(source, '/sw.js')['Service-Worker-Allowed'], '/');
  assert.equal(previewHeaders(source, '/api/plan')['Cache-Control'], 'no-cache');
  assert.doesNotMatch(source, new RegExp(publicKey));
  assert.deepEqual(
    previewHeaders(cloudflareHeaders(readReleaseConfiguration({}))),
    releaseHeaders(readReleaseConfiguration({})),
  );
});

test('preview rejects weakened, incomplete or foreign artifact policies without echoing values', () => {
  const source = cloudflareHeaders(readReleaseConfiguration(env));
  for (const candidate of [
    source.replace('nosniff', 'unsafe'),
    source.replace("'wasm-unsafe-eval'", "'unsafe-eval'"),
    source.replace('https://synthetic-project.supabase.co', 'http://accounts.example.test'),
    source.replace(
      'https://synthetic-project.supabase.co',
      'https://user:synthetic-private@accounts.example.test',
    ),
    source.replace(
      'https://synthetic-project.supabase.co',
      'https://synthetic-project.supabase.co/',
    ),
    source + '\n/api/*\n  Cache-Control: public\n',
    'synthetic-private',
  ])
    assert.throws(
      () => previewHeaders(candidate),
      (error) => error.message === 'artifact_header_policy_invalid',
    );
});
