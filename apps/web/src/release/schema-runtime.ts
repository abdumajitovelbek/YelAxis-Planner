import { config } from 'zod/v4';

// Build alias for root Zod imports: runs before application schema construction, even in a shared chunk.
config({ jitless: true });
export * from 'zod/v4';
