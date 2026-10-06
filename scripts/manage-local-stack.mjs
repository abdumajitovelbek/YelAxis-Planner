import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectLocalTestStack } from './lib/local-test-stack.mjs';

/** Lifecycle commands always belong to this repository's disposable stack, never a test override. */
export function manageLocalStack(repositoryRoot, action, execute = spawnSync) {
  if (!['start', 'stop', 'reset'].includes(action)) throw new Error('local_stack_action_invalid');
  const selected = selectLocalTestStack(repositoryRoot);
  const args = action === 'reset' ? ['db', 'reset'] : [action];
  const result = execute(selected.binary, [...args, '--workdir', selected.workdir], {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  // Supabase prints privileged configuration on startup. Do not forward its output, even on failure.
  if (result.status !== 0 || result.error) throw new Error(`local_stack_${action}_failed`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('local_stack_action_invalid');
    manageLocalStack(fileURLToPath(new URL('../', import.meta.url)), process.argv[2]);
    console.log(`Disposable YelAxis Planner stack: ${process.argv[2]} completed.`);
  } catch (error) {
    console.error(`${error.message}. Check Docker, available ports and the local configuration.`);
    process.exitCode = 1;
  }
}
