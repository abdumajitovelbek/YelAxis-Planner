import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  localTestStackUnavailable,
  readLocalTestStack,
  selectLocalTestStack,
} from '../lib/local-test-stack.mjs';
import {
  configureWebAccount,
  serializeWebAccountConfiguration,
} from '../configure-web-account.mjs';

const config = (projectId = 'yelaxis-planner', apiPort = 57421) =>
  `project_id = "${projectId}"\n[api]\nenabled = true\nport = ${apiPort}\n[api.tls]\nenabled = false\n`;
const status = (apiUrl = 'http://127.0.0.1:57421') =>
  [
    'API_URL="' + apiUrl + '"',
    'ANON_KEY="synthetic-public"',
    'SERVICE_ROLE_KEY="synthetic-private"',
    'JWT_SECRET="<synthetic-signing>"',
  ].join('\n');

function fixture(run) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'yelaxis-local-stack-')));
  const root = join(parent, 'planner');
  const override = join(parent, 'selected-local-stack');
  try {
    for (const path of [root, override]) {
      mkdirSync(join(path, 'supabase'), { recursive: true });
      writeFileSync(join(path, 'supabase', 'config.toml'), config());
    }
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(
      join(
        root,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
      ),
      'synthetic-cli',
    );
    return run({ root, override });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

const safeFailure = (error) =>
  error.message === localTestStackUnavailable && !error.message.includes('synthetic-private');

test('default selection requires the independent public project identity and API port', () => {
  fixture(({ root }) => {
    const selected = selectLocalTestStack(root);
    assert.equal(selected.projectId, 'yelaxis-planner');
    assert.equal(selected.apiPort, 57421);
    assert.equal(selected.workdir, root);
    for (const source of [
      config('other-project'),
      config('yelaxis-planner', 60123),
      config().replace('enabled = true', 'enabled = false'),
      config() + '[api]\nport = 60123\n',
    ]) {
      writeFileSync(join(root, 'supabase', 'config.toml'), source);
      assert.throws(() => selectLocalTestStack(root), safeFailure);
    }
  });
});

test('explicit local override validates its config and sends every CLI status call to that workdir', () => {
  fixture(({ root, override }) => {
    writeFileSync(join(override, 'supabase', 'config.toml'), config('selected-fixture', 60123));
    let calls = 0;
    const stack = readLocalTestStack(root, {
      workdirOverride: override,
      execute(command, args, options) {
        calls += 1;
        assert.equal(command, selectLocalTestStack(root).binary);
        assert.deepEqual(args, ['status', '--workdir', override, '-o', 'env']);
        assert.equal(options.encoding, 'utf8');
        return { status: 0, stdout: status('http://127.0.0.1:60123') };
      },
    });
    assert.equal(calls, 1);
    assert.equal(stack.projectId, 'selected-fixture');
    assert.equal(stack.apiUrl, 'http://127.0.0.1:60123');
    assert.equal(stack.workdir, override);
    assert.throws(() => selectLocalTestStack(root, 'relative/local-stack'), safeFailure);
    assert.throws(() => selectLocalTestStack(root, 'https://example.test'), safeFailure);
  });
});

test('runtime must match the chosen local API, with no remote endpoint, authority, hidden path or duplicate keys', () => {
  fixture(({ root }) => {
    for (const output of [
      status('https://remote.example.test:57421'),
      status('http://127.0.0.1.example.test:57421'),
      status('http://127.0.0.1:60123'),
      status('http://user:synthetic-private@127.0.0.1:57421'),
      status('http://127.0.0.1:57421/rest/v1'),
      status('http://127.0.0.1:57421/a/..'),
      status('http://127.0.0.1:57421/?'),
      status('http://127.0.0.1:57421/#'),
      status() + '\nANON_KEY="duplicate"',
      status().replace('JWT_SECRET="<synthetic-signing>"', ''),
    ])
      assert.throws(
        () =>
          readLocalTestStack(root, {
            workdirOverride: '',
            execute: () => ({ status: 0, stdout: output }),
          }),
        safeFailure,
      );
    assert.throws(
      () => readLocalTestStack(root, { execute: () => ({ status: 1, stdout: status() }) }),
      safeFailure,
    );
    assert.throws(
      () =>
        readLocalTestStack(root, {
          execute: () => {
            throw new Error('synthetic-private');
          },
        }),
      safeFailure,
    );
  });
});

test('missing config or CLI fails before any runtime command runs', () => {
  fixture(({ root, override }) => {
    rmSync(join(root, 'node_modules'), { recursive: true });
    let calls = 0;
    assert.throws(
      () =>
        readLocalTestStack(root, {
          workdirOverride: override,
          execute: () => {
            calls += 1;
            return { status: 0, stdout: status() };
          },
        }),
      safeFailure,
    );
    assert.equal(calls, 0);
  });
});

const publicBrowserKey = ['sb', 'publishable', 'synthetic'.repeat(5)].join('_');
const browserStack = () => ({
  apiUrl: 'http://127.0.0.1:57421',
  anonKey: publicBrowserKey,
  serviceRoleKey: 'synthetic-private',
  jwtSecret: 'synthetic-signing',
  privateExtra: 'synthetic-additional-private',
});

test('web configuration serializes exactly public URL and key, excluding every other stack value', () => {
  const contents = serializeWebAccountConfiguration(browserStack());
  assert.equal(
    contents,
    `VITE_YELAXIS_SUPABASE_URL=http://127.0.0.1:57421\nVITE_YELAXIS_SUPABASE_ANON_KEY=${publicBrowserKey}\n`,
  );
  assert.doesNotMatch(
    contents,
    /synthetic-private|synthetic-signing|synthetic-additional-private|SERVICE_ROLE|JWT_SECRET/,
  );
  for (const anonKey of [
    ['sb', 'secret', 'synthetic'.repeat(5)].join('_'),
    publicBrowserKey + '\nSERVICE_ROLE_KEY=synthetic-private',
    [
      Buffer.from('{}').toString('base64url'),
      Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'),
      'synthetic-signature',
    ].join('.'),
  ])
    assert.throws(
      () => serializeWebAccountConfiguration({ ...browserStack(), anonKey }),
      /must_be_public/,
    );
});

test('web configuration refuses overwrite, permits an explicit force, and leaves only a restricted complete file', () => {
  fixture(({ root }) => {
    const web = join(root, 'apps', 'web');
    const destination = join(web, '.env.local');
    mkdirSync(web, { recursive: true });
    writeFileSync(destination, 'VITE_EXISTING=synthetic-existing\n');
    let calls = 0;
    const stackLoader = () => {
      calls += 1;
      return browserStack();
    };
    assert.throws(
      () => configureWebAccount({ repositoryRoot: root, stackLoader }),
      /requires_force/,
    );
    assert.equal(calls, 0);
    assert.equal(readFileSync(destination, 'utf8'), 'VITE_EXISTING=synthetic-existing\n');
    configureWebAccount({ repositoryRoot: root, force: true, stackLoader });
    assert.equal(
      readFileSync(destination, 'utf8'),
      serializeWebAccountConfiguration(browserStack()),
    );
    assert.deepEqual(readdirSync(web), ['.env.local']);
    if (process.platform !== 'win32') assert.equal(statSync(destination).mode & 0o777, 0o600);
  });
});

test('empty placeholder configuration is replaceable and failed preparation preserves it exactly', () => {
  fixture(({ root }) => {
    const web = join(root, 'apps', 'web');
    const destination = join(web, '.env.local');
    mkdirSync(web, { recursive: true });
    const source =
      '# public placeholders\nVITE_YELAXIS_SUPABASE_URL=\nVITE_YELAXIS_SUPABASE_ANON_KEY=\n';
    writeFileSync(destination, source);
    assert.throws(
      () =>
        configureWebAccount({
          repositoryRoot: root,
          stackLoader: () => {
            throw new Error('synthetic-private');
          },
        }),
      (error) => error.message === 'web_account_configuration_failed',
    );
    assert.equal(readFileSync(destination, 'utf8'), source);
    assert.deepEqual(readdirSync(web), ['.env.local']);
    configureWebAccount({ repositoryRoot: root, stackLoader: browserStack });
    assert.equal(
      readFileSync(destination, 'utf8'),
      serializeWebAccountConfiguration(browserStack()),
    );
  });
});

test('a file created during preparation is preserved and the temporary file is retired', () => {
  fixture(({ root }) => {
    const web = join(root, 'apps', 'web');
    const destination = join(web, '.env.local');
    mkdirSync(web, { recursive: true });
    assert.throws(
      () =>
        configureWebAccount({
          repositoryRoot: root,
          stackLoader: () => {
            writeFileSync(destination, 'VITE_EXISTING=synthetic-racing-writer\n');
            return browserStack();
          },
        }),
      /web_account_configuration_failed/,
    );
    assert.equal(readFileSync(destination, 'utf8'), 'VITE_EXISTING=synthetic-racing-writer\n');
    assert.deepEqual(readdirSync(web), ['.env.local']);
  });
});
