import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { collectRepositoryFiles } from './repository-files.mjs';

/** Content-based validation policy works from Git checkouts and source archives without credentials. */
export function releaseHealthPolicy(root) {
  const files = collectRepositoryFiles(root)
    .filter(({ relativePath: path }) => {
      if (['pnpm-lock.yaml', 'package.json', 'apps/web/vite.config.ts'].includes(path)) return true;
      if (/^(?:apps\/web|packages\/[^/]+)\/package\.json$/u.test(path)) return true;
      if (
        /^scripts\/lib\/.*\.mjs$/u.test(path) ||
        /^apps\/web\/scripts\/lib\/release-config\.mjs$/u.test(path)
      )
        return true;
      if (!/^(?:apps\/web|packages\/[^/]+)\/src\/.*\.[cm]?[jt]sx?$/u.test(path)) return false;
      return !/(?:\.(?:test|spec)\.|\/(?:__fixtures__|__tests__|testing|fixtures|tests?)\/)/u.test(
        path,
      );
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  if (files.length === 0) throw new Error('release_health_policy_sources_missing');
  const hash = createHash('sha256').update('yelaxis-health-policy-v1\0');
  for (const file of files)
    hash
      .update(file.relativePath)
      .update('\0')
      .update(readFileSync(file.absolutePath))
      .update('\0');
  // The worker's existing policy contract is a 40-character opaque fingerprint, not a Git claim.
  return hash.digest('hex').slice(0, 40);
}
