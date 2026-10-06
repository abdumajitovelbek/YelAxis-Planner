import { defineConfig } from 'vitest/config';

/**
 * account sync backend tests against the local `yelaxis` Supabase stack (Docker). Run with
 * `pnpm run test:backend`; the normal `test` script never runs them, so `pnpm run check` needs no
 * Docker.
 */
export default defineConfig({
  test: {
    include: ['src/backend/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./src/backend/global-setup.ts'],
    // The files share one stack; each uses its own synthetic users.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
