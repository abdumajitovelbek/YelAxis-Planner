/**
 * The identity index: which planning identities this browser holds, which database
 * each one uses, and which one opens at launch. It holds ids, kinds, database names, the active id,
 * an account's sign-in email for display and signing in again, and whether a copy waits to be
 * removed; never planning content, sessions, or tokens. Reads are defensive: an entry that is not
 * valid is left out and the valid ones are kept, and an index that cannot be read at all is treated
 * as missing. Before such a damaged index is replaced, its text is kept under its own key, so the
 * databases it named are never forgotten silently.
 */

export const identityIndexKey = 'yelaxis.identities';

/** Where the text of a damaged index is kept before the index is written again. */
export const preservedIdentityIndexKey = 'yelaxis.identities.unreadable';

/** The original local identity's database: unchanged from before identities had their own. */
export const defaultLocalDatabaseName = '/yelaxis.sqlite3';

/** The subset of `Storage` the index needs (tests pass a fake). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocalIdentityEntry {
  readonly id: string;
  readonly kind: 'local';
  readonly databaseName: string;
}

export interface AccountIdentityEntry {
  readonly id: string;
  readonly kind: 'account';
  readonly databaseName: string;
  readonly accountSubjectId: string;
  /** For display and for signing in again; null when the index was rebuilt without it. */
  readonly email: string | null;
  /**
   * The person chose to delete this device's copy (removing the account from this device, or
   * deleting the account). Written before the local plan opens, so a removal that fails or is cut
   * short is tried again at the next launch; the copy never opens again.
   */
  readonly removalPending?: true;
}

export type IdentityIndexEntry = LocalIdentityEntry | AccountIdentityEntry;

/** Whether this entry's database waits to be removed. */
export function isRemovalPending(entry: IdentityIndexEntry): boolean {
  return entry.kind === 'account' && entry.removalPending === true;
}

export interface IdentityIndex {
  readonly version: 1;
  readonly activeId: string | null;
  readonly identities: readonly IdentityIndexEntry[];
}

export const emptyIdentityIndex: IdentityIndex = Object.freeze({
  version: 1,
  activeId: null,
  identities: Object.freeze([]),
});

const maximumEntries = 32;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const databaseNamePattern = /^\/[A-Za-z0-9._-]+\.sqlite3$/u;

/**
 * The browser worker's SQLite VFS allows 64-character paths, and SQLite opens a database only when
 * its name plus `-journal` fits, so a database name has at most 56 characters.
 */
export const maximumDatabaseNameLength = 56;

export function isDatabaseName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maximumDatabaseNameLength &&
    databaseNamePattern.test(value)
  );
}

/** A UUID without its hyphens, so a database name stays within the length the VFS allows. */
function compact(uuid: string): string {
  return uuid.replaceAll('-', '');
}

/** A new local identity's database. */
export function localDatabaseName(token: string): string {
  return `/yelaxis-local-${compact(token)}.sqlite3`;
}

/** An account's replica on this device: the same name whenever that account returns. */
export function accountDatabaseName(accountSubjectId: string): string {
  return `/yelaxis-acct-${compact(accountSubjectId)}.sqlite3`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseEntry(value: unknown): IdentityIndexEntry | null {
  if (!isRecord(value)) return null;
  const { id, kind, databaseName } = value;
  if (typeof id !== 'string' || !uuidPattern.test(id) || !isDatabaseName(databaseName)) {
    return null;
  }
  if (kind === 'local') {
    return Object.keys(value).length === 3 ? { id, kind, databaseName } : null;
  }
  if (kind !== 'account') return null;
  const { accountSubjectId, email, removalPending } = value;
  const flagged = removalPending === true;
  if (
    Object.keys(value).length !== (flagged ? 6 : 5) ||
    typeof accountSubjectId !== 'string' ||
    !uuidPattern.test(accountSubjectId) ||
    !(email === null || (typeof email === 'string' && email.length > 0 && email.length <= 320))
  ) {
    return null;
  }
  return {
    id,
    kind,
    databaseName,
    accountSubjectId,
    email,
    ...(flagged ? { removalPending: true as const } : {}),
  };
}

/** What a stored index held: the usable index, and whether it was read exactly as written. */
export interface IdentityIndexReading {
  /** Null when nothing usable was stored (not an object, not version 1, or unreadable JSON). */
  readonly index: IdentityIndex | null;
  /** False when anything was left out or repaired; the text is then kept before a new write. */
  readonly intact: boolean;
}

/**
 * Reads an index tolerantly: entries that are not valid, repeat an id or a database name, or exceed
 * the limit are left out, and the valid ones are kept (the active one and the newest first).
 */
export function inspectIdentityIndex(text: string | null): IdentityIndexReading {
  if (text === null) return { index: null, intact: true };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { index: null, intact: false };
  }
  if (!isRecord(value) || value['version'] !== 1 || !Array.isArray(value['identities'])) {
    return { index: null, intact: false };
  }
  let intact = Object.keys(value).length === 3;
  const ids = new Set<string>();
  const names = new Set<string>();
  let entries: IdentityIndexEntry[] = [];
  for (const candidate of value['identities'] as unknown[]) {
    const entry = parseEntry(candidate);
    if (entry === null || ids.has(entry.id) || names.has(entry.databaseName)) {
      intact = false;
      continue;
    }
    ids.add(entry.id);
    names.add(entry.databaseName);
    entries.push(entry);
  }
  const candidateActive = value['activeId'];
  let activeId: string | null = null;
  if (typeof candidateActive === 'string' && ids.has(candidateActive)) activeId = candidateActive;
  else if (candidateActive !== null) intact = false;
  if (entries.length > maximumEntries) {
    entries = capped(entries, activeId, null);
    intact = false;
  }
  return { index: { version: 1, activeId, identities: entries }, intact };
}

/** Parses an index tolerantly (see `inspectIdentityIndex`); null when nothing usable is stored. */
export function parseIdentityIndex(text: string | null): IdentityIndex | null {
  return inspectIdentityIndex(text).index;
}

/** The stored index text and its reading; null when nothing is stored or storage refuses. */
export function readStoredIdentityIndex(
  storage: KeyValueStorage | null,
): (IdentityIndexReading & { readonly text: string }) | null {
  if (storage === null) return null;
  try {
    const text = storage.getItem(identityIndexKey);
    return text === null ? null : { ...inspectIdentityIndex(text), text };
  } catch {
    return null;
  }
}

/** Reads the index; null when it is missing, unusable, or storage is unavailable. */
export function readIdentityIndex(storage: KeyValueStorage | null): IdentityIndex | null {
  return readStoredIdentityIndex(storage)?.index ?? null;
}

/**
 * Keeps the text of a damaged index under its own key before the index is written again. True when
 * the text is kept (now or already); false when storage refuses or holds a different damaged index,
 * in which case the index must not be overwritten.
 */
export function preserveIdentityIndex(storage: KeyValueStorage | null, text: string): boolean {
  if (storage === null) return false;
  try {
    const kept = storage.getItem(preservedIdentityIndexKey);
    if (kept === text) return true;
    if (kept !== null) return false;
    storage.setItem(preservedIdentityIndexKey, text);
    return true;
  } catch {
    return false;
  }
}

/** Writes the index; false when storage refuses (the session keeps it in memory). */
export function writeIdentityIndex(storage: KeyValueStorage | null, index: IdentityIndex): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(identityIndexKey, JSON.stringify(index));
    return true;
  } catch {
    return false;
  }
}

/**
 * At most `maximumEntries`, in their order: the oldest are left out first, never the active entry
 * or `newest`.
 */
function capped(
  entries: readonly IdentityIndexEntry[],
  activeId: string | null,
  newest: string | null,
): IdentityIndexEntry[] {
  let excess = entries.length - maximumEntries;
  if (excess <= 0) return [...entries];
  return entries.filter((entry) => {
    if (excess <= 0 || entry.id === activeId || entry.id === newest) return true;
    excess -= 1;
    return false;
  });
}

/**
 * Replaces the entry with the same database (or adds it) as the newest, and optionally makes it
 * active. The order is the order of use: the last entry was used most recently.
 */
export function withEntry(
  index: IdentityIndex,
  entry: IdentityIndexEntry,
  makeActive: boolean,
): IdentityIndex {
  const others = index.identities.filter(
    (candidate) => candidate.databaseName !== entry.databaseName && candidate.id !== entry.id,
  );
  const activeId = makeActive
    ? entry.id
    : index.activeId !== null && [...others, entry].some(({ id }) => id === index.activeId)
      ? index.activeId
      : null;
  return { version: 1, activeId, identities: capped([...others, entry], activeId, entry.id) };
}

/** Removes the entry of one database. */
export function withoutDatabase(index: IdentityIndex, databaseName: string): IdentityIndex {
  const identities = index.identities.filter(
    (candidate) => candidate.databaseName !== databaseName,
  );
  const activeId =
    index.activeId !== null && identities.some(({ id }) => id === index.activeId)
      ? index.activeId
      : null;
  return { version: 1, activeId, identities };
}
