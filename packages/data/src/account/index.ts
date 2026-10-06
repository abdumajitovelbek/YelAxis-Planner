/** account sync identity, linking, export, and account lifecycle adapters. */
export {
  bundleSections,
  bundleSupplementSections,
  CanonicalBundleCodec,
  canonicalBundleFormat,
  canonicalBundleFormatVersion,
  canonicalJson,
  sha256Hex,
} from './canonical-bundle';
export {
  countCanonicalRecords,
  readCanonicalSnapshot,
  snapshotSources,
} from './canonical-snapshot';
export type { SnapshotSource } from './canonical-snapshot';
export { contextDocumentSchema, decodeContextRow, readContextRecord } from './context-document';
export type { ContextDocument } from './context-document';
export { canonicalRecordTables, ownedTables, profileReferenceTables } from './owned-tables';
export type { OwnedTable } from './owned-tables';
export { createSqliteAccountAdapters, SqliteAccountStore } from './sqlite-account-store';
export type { SqliteAccountAdapters, SqliteAccountStoreOptions } from './sqlite-account-store';
