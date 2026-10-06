/// <reference types="vite/client" />

/**
 * Build-time public account configuration. Only the API URL and the public anon key
 * reach the browser; a build without them is local-only.
 */
interface ImportMetaEnv {
  readonly VITE_YELAXIS_SUPABASE_URL?: string;
  readonly VITE_YELAXIS_SUPABASE_ANON_KEY?: string;
}
