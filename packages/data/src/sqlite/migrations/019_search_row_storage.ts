import { searchMigration } from './015_search';
import { defineMigration } from './migration';

/** Reuse immutable v15 column, index and token-trigger definitions without retokenizing content. */
function frozenSearchFragment(start: string, end: string): string {
  const begin = searchMigration.sql.indexOf(start);
  const finish = searchMigration.sql.indexOf(end, begin + start.length);
  if (
    begin < 0 ||
    finish <= begin ||
    searchMigration.sql.indexOf(start, begin + start.length) !== -1
  ) {
    throw new Error('The immutable Search migration fragment could not be identified.');
  }
  return searchMigration.sql.slice(begin, finish);
}

const oldDocumentSchema = frozenSearchFragment(
  'CREATE TABLE search_documents (',
  'CREATE INDEX idx_search_placements_dates',
);
const compositeKey = 'PRIMARY KEY(owner_id, kind, entity_id)';
const oldTableOptions = ') WITHOUT ROWID, STRICT;';
if (
  oldDocumentSchema.split(compositeKey).length !== 2 ||
  oldDocumentSchema.split(oldTableOptions).length !== 2 ||
  oldDocumentSchema.match(/CREATE INDEX idx_search_documents_/gu)?.length !== 6
) {
  throw new Error('The immutable Search table definition did not match its expected layout.');
}
const documentSchema = oldDocumentSchema
  .replace(compositeKey, 'UNIQUE(owner_id, kind, entity_id)')
  .replace(oldTableOptions, ') STRICT;');
const documentTriggers = frozenSearchFragment(
  'CREATE TRIGGER trg_search_documents_tokens_insert',
  'CREATE VIEW search_source_documents (',
);
if (
  documentTriggers.match(/CREATE TRIGGER trg_search_documents_tokens_/gu)?.length !== 2 ||
  !documentTriggers.includes('CREATE TRIGGER trg_search_documents_tokens_update')
) {
  throw new Error('The immutable Search token triggers did not match their expected definitions.');
}

/**
 * Derived Search prose belongs in a rowid table; its compact UNIQUE owner/type/id index remains the
 * exact key for lookups, UPSERT and the unchanged token foreign key. Full integrity and relationship
 * checks then inspect compact index entries rather than repeatedly traversing prose-heavy keys.
 *
 * The migration runner owns the transaction with foreign keys ON. TEMP copies preserve every
 * document/token field. Dropping the parent cascades only derived tokens; restoring the same parent
 * name avoids rewriting child references, canonical triggers or the source view. Token triggers are
 * restored after both exact row copies, so no normalization, retokenization or canonical write runs.
 * No VACUUM, reset, foreign-key bypass or canonical table/schema modification is performed.
 */
export const searchRowStorageMigration = defineMigration(
  19,
  'search_row_storage',
  `
  CREATE TEMP TABLE yelaxis_search_documents_v19 AS SELECT * FROM search_documents;
  CREATE TEMP TABLE yelaxis_search_tokens_v19 AS SELECT * FROM search_tokens;
  DROP TABLE search_documents;
  ${documentSchema}
  INSERT INTO search_documents SELECT * FROM temp.yelaxis_search_documents_v19;
  INSERT INTO search_tokens SELECT * FROM temp.yelaxis_search_tokens_v19;
  ${documentTriggers}
  DROP TABLE temp.yelaxis_search_documents_v19;
  DROP TABLE temp.yelaxis_search_tokens_v19;
`,
);
