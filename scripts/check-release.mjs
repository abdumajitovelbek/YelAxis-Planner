import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectRepositoryFiles } from './lib/repository-files.mjs';
import { scanSecrets } from './scan-secrets.mjs';

export function checkReleaseSources(root = process.cwd()) {
  const findings = [];
  let checked = 0;
  for (const file of collectRepositoryFiles(root)) {
    const path = file.relativePath;
    if (
      !/^(?:packages\/(?:domain|application)|apps\/web)\/src\/.*\.[jt]sx?$/.test(path) ||
      /(?:\.test\.|\.integration\.|\/testing\/|\/fixtures\/)/.test(path)
    )
      continue;
    checked++;
    const text = readFileSync(file.absolutePath, 'utf8');
    const imports = [...text.matchAll(/(?:from\s*|import\s*\(|import\s*)['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    const outward = path.startsWith('packages/domain/')
      ? /^(?:@yelaxis\/(?!domain)|react|.*sqlite|@supabase|.*notification)/i
      : path.startsWith('packages/application/')
        ? /^(?:@yelaxis\/(?:data|sync|ui)|react|.*sqlite|@supabase)/i
        : null;
    if (outward && imports.some((name) => outward.test(name)))
      findings.push({ path, rule: 'outward-import' });
    if (/\b(?:console\.(?:log|debug|info|warn|error)|sendBeacon)\s*\(/.test(text))
      findings.push({ path, rule: 'runtime-log-or-telemetry' });
  }
  return { checked, findings };
}

export function checkReleaseArtifact(directory = 'apps/web/dist') {
  const root = resolve(directory);
  const files = [];
  function walk(path, prefix = '') {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('release_artifact_symlink_refused');
      const name = prefix + entry.name;
      if (entry.isDirectory()) walk(resolve(path, entry.name), name + '/');
      else files.push({ absolutePath: resolve(path, entry.name), relativePath: name });
    }
  }
  walk(root);
  const forbidden = files.filter((f) =>
    /(?:\.map$|(?:^|\/)\.env|(?:^|\/)(?:test|backup|import|export|plan|auth)\/)/.test(
      f.relativePath,
    ),
  );
  if (forbidden.length) throw new Error('release_artifact_private_or_debug_file');
  if (scanSecrets({ root, files }).length)
    throw new Error('release_artifact_private_credential_pattern');
  const required = ['index.html', 'sw.js', 'manifest.webmanifest', '_headers'];
  if (required.some((path) => !files.some((f) => f.relativePath === path)))
    throw new Error('release_artifact_missing_shell');
  const headers = readFileSync(resolve(root, '_headers'), 'utf8');
  for (const text of [
    "script-src 'self' 'wasm-unsafe-eval'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    'X-Content-Type-Options: nosniff',
    'Referrer-Policy: no-referrer',
    'Cache-Control: no-cache',
  ]) {
    if (!headers.includes(text)) throw new Error('release_artifact_required_header_missing');
  }
  if (/['"]unsafe-eval['"]|https?:\/\/[^\s]+\*/.test(headers))
    throw new Error('release_artifact_broad_policy');
  return {
    files: files
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map((f) => ({
        path: f.relativePath,
        bytes: statSync(f.absolutePath).size,
        sha256: createHash('sha256').update(readFileSync(f.absolutePath)).digest('hex'),
      })),
    headers: 'reviewed static-only policy',
    maps: 0,
    secretFindings: 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = checkReleaseSources();
  if (source.findings.length) {
    process.stderr.write(JSON.stringify(source) + '\n');
    process.exitCode = 1;
  } else {
    const artifact = process.argv.includes('--artifact') ? checkReleaseArtifact() : null;
    process.stdout.write(JSON.stringify({ source, artifact }, null, 2) + '\n');
  }
}
