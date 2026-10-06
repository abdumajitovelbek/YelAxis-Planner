import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readReleaseConfiguration } from '../apps/web/scripts/lib/release-config.mjs';
import { readLocalTestStack } from './lib/local-test-stack.mjs';

class ConfigurationError extends Error {}

/** Only public browser configuration crosses this serialization boundary. */
export function serializeWebAccountConfiguration(stack) {
  const anonKey = stack.anonKey.trim();
  const configuration = readReleaseConfiguration({
    VITE_YELAXIS_SUPABASE_URL: stack.apiUrl,
    VITE_YELAXIS_SUPABASE_ANON_KEY: anonKey,
  });
  if (configuration.apiOrigin === null) throw new Error('public_configuration_incomplete');
  return `VITE_YELAXIS_SUPABASE_URL=${configuration.apiOrigin}\nVITE_YELAXIS_SUPABASE_ANON_KEY=${anonKey}\n`;
}

function placeholderConfiguration(source) {
  return source.split('\n').every((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return true;
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/u.exec(trimmed);
    if (!assignment) return false;
    const value = assignment[1].trim();
    return /^(?:|""|''|<[^<>\r\n]+>|YOUR_[A-Z0-9_]+)(?:\s+#.*)?$/u.test(value);
  });
}

/** Prepare an ignored local file atomically; existing configured files require an explicit choice. */
export function configureWebAccount({
  repositoryRoot,
  force = false,
  stackLoader = readLocalTestStack,
}) {
  const destination = join(repositoryRoot, 'apps', 'web', '.env.local');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    const existing = existsSync(destination) ? lstatSync(destination) : null;
    if (existing !== null) {
      if (!existing.isFile() || existing.isSymbolicLink())
        throw new ConfigurationError('web_configuration_must_be_a_regular_file');
      if (!force && !placeholderConfiguration(readFileSync(destination, 'utf8')))
        throw new ConfigurationError('existing_web_configuration_requires_force');
    }
    const contents = serializeWebAccountConfiguration(stackLoader(repositoryRoot));
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (existing === null) {
      // Linking is atomic and cannot overwrite a file created after the initial check.
      linkSync(temporary, destination);
      unlinkSync(temporary);
    } else {
      const current = lstatSync(destination);
      if (
        current.dev !== existing.dev ||
        current.ino !== existing.ino ||
        current.size !== existing.size ||
        current.mtimeMs !== existing.mtimeMs ||
        !current.isFile()
      )
        throw new ConfigurationError('web_configuration_changed_during_preparation');
      renameSync(temporary, destination);
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new Error('web_account_configuration_failed');
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      throw new Error('web_account_configuration_failed');
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((value) => value !== '--force') || args.length > 1) {
    console.error('Usage: node scripts/configure-web-account.mjs [--force]');
    process.exit(1);
  }
  try {
    configureWebAccount({
      repositoryRoot: fileURLToPath(new URL('../', import.meta.url)),
      force: args.includes('--force'),
    });
    console.log('Public local account configuration written.');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
