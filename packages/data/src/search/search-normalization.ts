/** Pure deterministic SQLite function and query normalization; no planning content is logged. */
export function normalizeSearchText(value: unknown): string {
  return typeof value === 'string'
    ? value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
        .trim()
    : '';
}
