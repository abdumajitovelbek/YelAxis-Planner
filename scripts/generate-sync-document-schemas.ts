/**
 * Renders the server's document schemas and reference map from the record codecs into a Supabase
 * migration. Migrations are append-only: when the rendered SQL differs from the
 * latest generated migration, a new one is written; otherwise nothing changes.
 *
 *   pnpm exec tsx scripts/generate-sync-document-schemas.ts [--check] [--timestamp YYYYMMDDHHMMSS]
 *
 * `--check` exits non-zero when the latest generated migration is out of date.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  documentSchemaMigrationSuffix,
  renderDocumentSchemaMigration,
} from '../packages/data/src/application/document-schemas';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const migrations = join(root, 'supabase', 'migrations');

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function utcTimestamp(): string {
  return new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14);
}

const rendered = renderDocumentSchemaMigration();
const generated = readdirSync(migrations)
  .filter((name) => name.endsWith(documentSchemaMigrationSuffix))
  .sort();
const latest = generated.at(-1);
const current = latest === undefined ? null : readFileSync(join(migrations, latest), 'utf8');

if (current === rendered) {
  console.log(`Sync document schemas are up to date (${latest ?? 'none'}).`);
} else if (process.argv.includes('--check')) {
  console.error(
    'Sync document schemas differ from the record codecs. Run: pnpm exec tsx scripts/generate-sync-document-schemas.ts',
  );
  process.exitCode = 1;
} else {
  const timestamp = argumentValue('--timestamp') ?? utcTimestamp();
  if (!/^\d{14}$/u.test(timestamp)) throw new Error('The timestamp must be YYYYMMDDHHMMSS.');
  const name = `${timestamp}${documentSchemaMigrationSuffix}`;
  if (latest !== undefined && name <= latest) {
    throw new Error(`The new migration must sort after ${latest}.`);
  }
  writeFileSync(join(migrations, name), rendered);
  console.log(`Wrote supabase/migrations/${name}.`);
}
