import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { manageLocalStack, stackFailureReason } from '../manage-local-stack.mjs';

test('stack diagnostics expose fixed causes while discarding credential-bearing CLI text', () => {
  const cases = [
    [
      'client version 1.41 is too old. Minimum supported API version is 1.44',
      'docker_api_incompatible',
    ],
    ['exec: "docker": executable file not found', 'docker_cli_unavailable'],
    ['permission denied connecting to docker.sock', 'docker_socket_denied'],
    ['Cannot connect to the Docker daemon', 'docker_daemon_unavailable'],
    ['port is already allocated', 'port_in_use'],
    ['unrecognized synthetic failure', null],
  ];
  for (const [stderr, reason] of cases)
    assert.equal(
      stackFailureReason({
        stderr: `${stderr}\nsynthetic privileged material`,
        stdout: 'synthetic password',
      }),
      reason,
    );
});

test('lifecycle ignores test overrides and never forwards CLI credential output', () => {
  const root = mkdtempSync(join(tmpdir(), 'planner-stack-'));
  const previous = process.env.YELAXIS_TEST_STACK_WORKDIR;
  try {
    mkdirSync(join(root, 'supabase'));
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(
      join(
        root,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
      ),
      '',
    );
    writeFileSync(
      join(root, 'supabase', 'config.toml'),
      'project_id = "yelaxis-planner"\n[api]\nenabled = true\nport = 57421\n',
    );
    process.env.YELAXIS_TEST_STACK_WORKDIR = '/unrelated-stack';
    const execute = (_binary, args) => {
      assert.deepEqual(args, ['db', 'reset', '--workdir', root]);
      return { status: 1, stdout: 'synthetic privileged material', stderr: 'synthetic password' };
    };
    assert.throws(() => manageLocalStack(root, 'reset', execute), {
      message: 'local_stack_reset_failed',
    });
    assert.throws(() => manageLocalStack(root, 'delete', execute), {
      message: 'local_stack_action_invalid',
    });
  } finally {
    if (previous === undefined) delete process.env.YELAXIS_TEST_STACK_WORKDIR;
    else process.env.YELAXIS_TEST_STACK_WORKDIR = previous;
    rmSync(root, { force: true, recursive: true });
  }
});
