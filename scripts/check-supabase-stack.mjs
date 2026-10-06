// Verifies the selected local Supabase test stack before backend tests.
// Reads `supabase status` output in memory only; no key or password is ever printed.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalTestStack } from './lib/local-test-stack.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const message =
  'The selected local YelAxis Planner test stack is not running or does not match its config. ' +
  'Start a disposable test stack with `pnpm run supabase:start` ' +
  '(Docker required) and apply migrations with `pnpm run supabase:reset`, then run ' +
  '`pnpm run test:backend` again.';

try {
  readLocalTestStack(root);
} catch {
  console.error(message);
  process.exit(1);
}
console.log('The selected local YelAxis Planner test stack is running.');
