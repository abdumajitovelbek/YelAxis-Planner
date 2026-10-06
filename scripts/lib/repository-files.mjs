import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const FALLBACK_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.pnpm-store',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'web-build',
]);

function collectWithGit(root) {
  const result = spawnSync(
    'git',
    ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  if (result.status !== 0 || result.error) return null;

  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((relativePath) => ({
      absolutePath: resolve(root, relativePath),
      relativePath: relativePath.replaceAll('\\', '/'),
    }));
}

function collectByWalking(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && FALLBACK_IGNORED_DIRECTORIES.has(entry.name)) return [];

    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectByWalking(root, absolutePath);
    if (!entry.isFile()) return [];

    return [
      {
        absolutePath,
        relativePath: absolutePath.slice(root.length + 1).replaceAll('\\', '/'),
      },
    ];
  });
}

export function collectRepositoryFiles(root) {
  return collectWithGit(root) ?? collectByWalking(root);
}
