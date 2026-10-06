/** Only build-owned static paths may appear in service-worker caches. Hashes are opaque. */
export function isStaticCacheUrl(value, origin, planIds = []) {
  const url = new URL(value);
  const staticPath =
    ['/', '/index.html', '/manifest.webmanifest', '/registerSW.js'].includes(url.pathname) ||
    /^\/assets\/[^/]+\.(?:js|css|wasm|woff2?)$/u.test(url.pathname) ||
    /^\/icons\/(?:[a-z0-9_-]+\/)*[^/]+\.(?:png|svg|ico)$/u.test(url.pathname) ||
    /^\/(?:favicon\.ico|icon[^/]*\.(?:png|svg))$/u.test(url.pathname);
  return (
    url.origin === origin &&
    staticPath &&
    [...url.searchParams.keys()].every((key) => key === '__WB_REVISION__') &&
    !planIds.some((id) => value.includes(id))
  );
}
