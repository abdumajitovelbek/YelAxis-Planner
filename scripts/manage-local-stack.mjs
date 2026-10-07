import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectLocalTestStack } from './lib/local-test-stack.mjs';

/** Return fixed diagnostic codes only; arbitrary CLI text may contain privileged configuration. */
export function stackFailureReason(result) {
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  if (result.error?.code === 'ENOENT') return 'cli_unavailable';
  if (
    /client version.*too old|minimum supported API version|API version.*not supported/iu.test(text)
  )
    return 'docker_api_incompatible';
  if (
    /docker.*(?:executable file not found|command not found)|exec:.*docker.*not found/iu.test(text)
  )
    return 'docker_cli_unavailable';
  if (/permission denied.*docker\.sock|docker\.sock.*permission denied/iu.test(text))
    return 'docker_socket_denied';
  if (
    /cannot connect to the docker daemon|is the docker daemon running|no such file.*docker\.sock/iu.test(
      text,
    )
  )
    return 'docker_daemon_unavailable';
  if (/address already in use|port is already allocated/iu.test(text)) return 'port_in_use';
  return null;
}

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
  if (result.status !== 0 || result.error) {
    const reason = stackFailureReason(result);
    throw new Error(`local_stack_${action}_failed${reason === null ? '' : `_${reason}`}`);
  }
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
