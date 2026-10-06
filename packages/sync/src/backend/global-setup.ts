import { stackEnvironment, waitForStack } from './stack';

/**
 * Fails the backend run up front, with a clear message, when the local stack is not running, and
 * waits for its services after a fresh `supabase db reset`.
 */
export default async function setup(): Promise<void> {
  stackEnvironment();
  await waitForStack();
}
