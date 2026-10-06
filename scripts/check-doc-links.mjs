import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

const root = process.cwd();
const ignoredDirectories = new Set(['.git', 'node_modules']);

function collectMarkdown(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignoredDirectories.has(entry.name)) return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectMarkdown(path);
    return extname(entry.name) === '.md' ? [path] : [];
  });
}

function normalizeTarget(rawTarget) {
  const target = rawTarget.trim().replace(/^<|>$/g, '');
  const withoutTitle = target.match(/^(\S+)(?:\s+["'].*["'])?$/)?.[1] ?? target;
  return decodeURIComponent(withoutTitle.split('#', 1)[0] ?? '');
}

const failures = [];

for (const file of collectMarkdown(root)) {
  const source = readFileSync(file, 'utf8');
  const linkPattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;

  for (const match of source.matchAll(linkPattern)) {
    const target = normalizeTarget(match[1] ?? '');
    if (
      target === '' ||
      target.startsWith('http://') ||
      target.startsWith('https://') ||
      target.startsWith('mailto:')
    ) {
      continue;
    }

    const resolved = resolve(dirname(file), target);
    if (!existsSync(resolved)) {
      failures.push(`${file.slice(root.length + 1)} -> ${target}`);
      continue;
    }

    if (statSync(resolved).isDirectory() && !existsSync(resolve(resolved, 'README.md'))) {
      failures.push(`${file.slice(root.length + 1)} -> ${target} (directory has no README.md)`);
    }
  }
}

if (failures.length > 0) {
  console.error('Broken local documentation links:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log('Documentation link check passed.');
}
