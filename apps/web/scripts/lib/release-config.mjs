const loopbackHost = (hostname) =>
  hostname === 'localhost' ||
  hostname === '[::1]' ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname);

/** Canonical origins are safe to place in CSP; normalization must not hide URL authority or paths. */
function backendOrigin(value) {
  const parsed = new URL(value);
  const hostname = parsed.hostname;
  const safeHost =
    hostname.length <= 253 &&
    (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(
      hostname,
    ) ||
      /^\[[a-f0-9:]+\]$/u.test(hostname));
  const local = parsed.protocol === 'http:' && loopbackHost(hostname) && parsed.port !== '';
  if (
    !safeHost ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/' ||
    (value !== parsed.origin && value !== `${parsed.origin}/`) ||
    (!local && parsed.protocol !== 'https:')
  )
    throw new Error();
  return parsed;
}

/** Build-time public configuration boundary. Never include a supplied value in an error. */
export function readReleaseConfiguration(env, target = 'local') {
  if (!['local', 'hosted'].includes(target)) throw new Error('release_target_invalid');
  const url = env.VITE_YELAXIS_SUPABASE_URL?.trim() ?? '';
  const key = env.VITE_YELAXIS_SUPABASE_ANON_KEY?.trim() ?? '';
  const revision = env.VITE_YELAXIS_RELEASE_REVISION?.trim() ?? '';
  if (revision && !/^[a-f0-9]{7,40}$/.test(revision)) throw new Error('release_revision_invalid');
  if (!url && !key) {
    return { target, apiOrigin: null, revision: revision || null };
  }
  if (!url || !key) throw new Error('public_configuration_incomplete');
  let parsed;
  try {
    parsed = backendOrigin(url);
  } catch {
    throw new Error('public_api_url_invalid');
  }
  if (target === 'hosted' && (parsed.protocol !== 'https:' || loopbackHost(parsed.hostname)))
    throw new Error('hosted_api_must_be_independent_https');
  if (!/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key)) {
    try {
      const parts = key.split('.');
      const claims = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
      if (
        parts.length !== 3 ||
        parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part)) ||
        claims === null ||
        typeof claims !== 'object' ||
        Array.isArray(claims) ||
        claims.role !== 'anon' ||
        ['sub', 'session_id', 'refresh_token', 'access_token'].some((field) =>
          Object.hasOwn(claims, field),
        )
      )
        throw new Error();
      if (
        /^[a-z0-9-]+\.supabase\.co$/u.test(parsed.hostname) &&
        claims.ref &&
        claims.ref !== parsed.hostname.split('.')[0]
      )
        throw new Error();
    } catch {
      throw new Error('browser_key_must_be_public_anonymous_configuration');
    }
  }
  return { target, apiOrigin: parsed.origin, revision: revision || null };
}

export function releaseHeaders(configuration) {
  const connect = configuration.apiOrigin ? ` 'self' ${configuration.apiOrigin}` : " 'self'";
  return {
    'Content-Security-Policy': `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src${connect}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Strict-Transport-Security': 'max-age=86400',
    'Cache-Control': 'no-cache',
  };
}

export function cloudflareHeaders(configuration) {
  const common = Object.entries(releaseHeaders(configuration))
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  return `/*\n${common}\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/sw.js\n  Cache-Control: no-cache\n  Service-Worker-Allowed: /\n`;
}

/** Read only the exact emitted policy; preview never reconstructs build configuration from env. */
export function previewHeaders(source, pathname = '/') {
  try {
    if (typeof source !== 'string' || source.length > 8192) throw new Error();
    const match = /; connect-src 'self'(?: ([^;\s]+))?; worker-src/u.exec(source);
    if (match === null) throw new Error();
    const apiOrigin = match[1] ?? null;
    if (apiOrigin !== null) {
      const parsed = backendOrigin(apiOrigin);
      if (parsed.origin !== apiOrigin) throw new Error();
    }
    const configuration = { apiOrigin };
    if (source !== cloudflareHeaders(configuration)) throw new Error();
    const headers = releaseHeaders(configuration);
    const path = new URL(pathname, 'http://preview.invalid').pathname;
    if (path.startsWith('/assets/'))
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    if (path === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    return headers;
  } catch {
    throw new Error('artifact_header_policy_invalid');
  }
}
