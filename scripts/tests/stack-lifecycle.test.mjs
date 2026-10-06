import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { manageLocalStack } from '../manage-local-stack.mjs';

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
