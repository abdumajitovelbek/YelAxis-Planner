/**
 * Base snapshot hashes: lowercase hex SHA-256 of the canonical JSON of a document
 * (object keys sorted by code unit, no whitespace, `undefined` members omitted). Every replica and
 * the server compute the same value for the same document.
 */
import { canonicalJson, type SyncDocument, type SyncDocumentHasher } from '@yelaxis/application';

export const snapshotHashAlgorithm = 'sha256-canonical-json-v1';

export function createSnapshotHasher(
  subtle: Pick<SubtleCrypto, 'digest'> = globalThis.crypto.subtle,
): SyncDocumentHasher {
  const encoder = new TextEncoder();
  return {
    async hash(document: SyncDocument): Promise<string> {
      const digest = await subtle.digest('SHA-256', encoder.encode(canonicalJson(document)));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    },
  };
}
