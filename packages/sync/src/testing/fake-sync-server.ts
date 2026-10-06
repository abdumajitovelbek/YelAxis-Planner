/**
 * An in-memory server with the semantics of protocol v1, for tests only: one owner,
 * atomic groups, idempotent operation and group receipts, base revision and snapshot-hash checks,
 * conflict candidates kept until closed, tombstones that refuse stale edits (an update whose base is
 * the tombstone's revision is an explicit restore), a monotonic change log with a latest-state
 * cursor, optional log compaction (`cursor_expired`), and reference checks. The transports it hands
 * out serialize every request and response through JSON and the protocol schemas, and can be made
 * offline, unavailable, expired, or lose an answer.
 */
import { canonicalJson, type SyncDocumentHasher } from '@yelaxis/application';

import { createSnapshotHasher } from '../hasher';
import {
  closeConflictRequestSchema,
  pullRequestSchema,
  pullResponseSchema,
  pushRequestSchema,
  pushResponseSchema,
  serverConflictSchema,
  syncLimits,
  type CloseConflictRequest,
  type ConflictKind,
  type PullRequest,
  type PullResponse,
  type PulledChange,
  type PushConflict,
  type PushOperation,
  type PushRequest,
  type PushResponse,
  type ServerConflict,
  type SyncEntityType,
  type SyncTransport,
  type TransportResult,
} from '../protocol';

interface ServerRecord {
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  readonly revision: number;
  readonly deleted: boolean;
  readonly document: Record<string, unknown> | null;
  readonly hash: string | null;
  /** Sequence of this record's latest change-log entry. */
  readonly sequence: number;
}

interface StoredConflict extends ServerConflict {
  open: boolean;
}

export interface FakeSyncServerOptions {
  /** Check `baseSnapshotHash` against the hash of the current document (default true). */
  readonly verifyHashes?: boolean;
  /** Refuse documents that refer to unknown or deleted records, and deletes still referred to. */
  readonly checkReferences?: boolean;
  readonly hasher?: SyncDocumentHasher;
}

export type FakeTransportMode =
  'online' | 'offline' | 'unavailable' | 'auth_expired' | 'invalid_response';

export interface FakeTransport extends SyncTransport {
  mode: FakeTransportMode;
  /** The next push is applied by the server but its answer never arrives. */
  loseNextPushAnswer: boolean;
  readonly calls: { push: number; pull: number; openConflicts: number; closeConflict: number };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const keyOf = (entityType: string, entityId: string): string => `${entityType}:${entityId}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class FakeSyncServer {
  readonly records = new Map<string, ServerRecord>();
  readonly conflicts = new Map<string, StoredConflict>();
  readonly #groupReceipts = new Map<string, PushResponse>();
  readonly #operationReceipts = new Set<string>();
  readonly #hasher: SyncDocumentHasher;
  readonly #verifyHashes: boolean;
  readonly #checkReferences: boolean;
  #sequence = 0;
  #compactedThrough = 0;
  #conflictCounter = 0;
  /** The next push is refused with this code (schema, ownership, or reference failures). */
  rejectNextPush: 'invalid_payload' | 'schema_mismatch' | 'missing_reference' | null = null;
  /** The account is being deleted: pushes are refused and pulls return empty pages. */
  deletionPending = false;
  /** Every accepted operation id, once (duplicate uploads would show up here). */
  readonly accepted: string[] = [];

  constructor(options: FakeSyncServerOptions = {}) {
    this.#hasher = options.hasher ?? createSnapshotHasher();
    this.#verifyHashes = options.verifyHashes ?? true;
    this.#checkReferences = options.checkReferences ?? true;
  }

  get sequence(): number {
    return this.#sequence;
  }

  /** Forget history before the current sequence: older cursors must reconcile from the start. */
  compactLog(): void {
    this.#compactedThrough = this.#sequence;
  }

  liveDocuments(): ReadonlyMap<string, Record<string, unknown>> {
    const result = new Map<string, Record<string, unknown>>();
    for (const [key, record] of this.records) {
      if (!record.deleted && record.document !== null) result.set(key, record.document);
    }
    return result;
  }

  openConflictList(): readonly ServerConflict[] {
    return [...this.conflicts.values()]
      .filter((conflict) => conflict.open)
      .map((conflict) => ({
        conflictId: conflict.conflictId,
        entityType: conflict.entityType,
        entityId: conflict.entityId,
        kind: conflict.kind,
        baseServerRevision: conflict.baseServerRevision,
        local: conflict.local,
        remote: conflict.remote,
        blockedMutationGroupId: conflict.blockedMutationGroupId,
        createdAt: conflict.createdAt,
      }));
  }

  /* ───────────────────────── Push ───────────────────────── */

  async push(raw: PushRequest): Promise<PushResponse> {
    const parsed = pushRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: 'rejected',
        mutationGroupId: raw.mutationGroupId,
        code: 'invalid_payload',
      };
    }
    const request = parsed.data;
    const receipt = this.#groupReceipts.get(request.mutationGroupId);
    if (receipt !== undefined) return clone(receipt);
    const rejected = (code: 'invalid_payload' | 'limit_exceeded' | 'missing_reference') =>
      ({ status: 'rejected', mutationGroupId: request.mutationGroupId, code }) as const;
    if (
      request.operations.some((operation) => this.#operationReceipts.has(operation.operationId))
    ) {
      return rejected('invalid_payload');
    }
    if (JSON.stringify(request).length > syncLimits.requestBytes) return rejected('limit_exceeded');
    if (this.deletionPending) {
      return {
        status: 'rejected',
        mutationGroupId: request.mutationGroupId,
        code: 'deletion_pending',
      };
    }
    if (this.rejectNextPush !== null) {
      const code = this.rejectNextPush;
      this.rejectNextPush = null;
      return { status: 'rejected', mutationGroupId: request.mutationGroupId, code };
    }

    const working = new Map<string, ServerRecord>();
    const read = (key: string) => working.get(key) ?? this.records.get(key);
    const conflicts: PushConflict[] = [];
    const results: { operation: PushOperation; next: ServerRecord | null; revision: number }[] = [];

    for (const operation of request.operations) {
      const key = keyOf(operation.entityType, operation.entityId);
      const current = read(key);
      if (
        operation.document !== null &&
        JSON.stringify(operation.document).length > syncLimits.documentBytes
      ) {
        return rejected('limit_exceeded');
      }
      const conflict = (kind: ConflictKind, remote: ServerRecord) => {
        conflicts.push({
          conflictId: this.#nextConflictId(),
          operationId: operation.operationId,
          entityType: operation.entityType,
          entityId: operation.entityId,
          kind,
          baseServerRevision: operation.baseServerRevision,
          remote: {
            serverRevision: remote.revision,
            deleted: remote.deleted,
            document: remote.deleted ? null : clone(remote.document),
          },
        });
      };

      if (operation.kind === 'create') {
        if (operation.document === null) return rejected('invalid_payload');
        if (current === undefined) {
          const next = await this.#record(operation, 1, false, operation.document);
          working.set(key, next);
          results.push({ operation, next, revision: 1 });
        } else if (
          !current.deleted &&
          canonicalJson(current.document) === canonicalJson(operation.document)
        ) {
          // A byte-equivalent existing record: accepted without a new revision.
          results.push({ operation, next: null, revision: current.revision });
        } else {
          conflict('create_collision', current);
        }
        continue;
      }

      if (current === undefined) return rejected('invalid_payload');
      if (operation.kind === 'update') {
        if (operation.document === null) return rejected('invalid_payload');
        if (current.deleted) {
          if (operation.baseServerRevision !== current.revision) {
            conflict('edit_versus_delete', current);
            continue;
          }
          // Restore edited: an explicit revision over the tombstone this replica has seen.
        } else if (!(await this.#baseMatches(operation, current))) {
          conflict('stale_base', current);
          continue;
        }
        const next = await this.#record(operation, current.revision + 1, false, operation.document);
        working.set(key, next);
        results.push({ operation, next, revision: next.revision });
        continue;
      }

      // delete
      if (current.deleted) {
        // From the tombstone's own revision: accepted, nothing changes; from an older one, the
        // record was deleted after this replica's base.
        if (operation.baseServerRevision === current.revision) {
          results.push({ operation, next: null, revision: current.revision });
        } else {
          conflict('edit_versus_delete', current);
        }
        continue;
      }
      if (!(await this.#baseMatches(operation, current))) {
        conflict('delete_versus_edit', current);
        continue;
      }
      const next = await this.#record(operation, current.revision + 1, true, null);
      working.set(key, next);
      results.push({ operation, next, revision: next.revision });
    }

    if (conflicts.length > 0) {
      for (const item of conflicts) {
        const operation = request.operations.find((op) => op.operationId === item.operationId);
        this.conflicts.set(item.conflictId, {
          conflictId: item.conflictId,
          entityType: item.entityType,
          entityId: item.entityId,
          kind: item.kind,
          baseServerRevision: item.baseServerRevision,
          local: {
            deleted: operation?.kind === 'delete',
            document: operation?.kind === 'delete' ? null : clone(operation?.document ?? null),
          },
          remote: item.remote,
          blockedMutationGroupId: request.mutationGroupId,
          createdAt: new Date(0).toISOString(),
          open: true,
        });
      }
      return { status: 'conflict', mutationGroupId: request.mutationGroupId, conflicts };
    }

    if (this.#checkReferences && !this.#referencesHold(working)) {
      return rejected('missing_reference');
    }

    for (const result of results) {
      if (result.next === null) continue;
      this.#sequence += 1;
      const stored = { ...result.next, sequence: this.#sequence };
      this.records.set(keyOf(stored.entityType, stored.entityId), stored);
    }
    for (const operation of request.operations) {
      this.#operationReceipts.add(operation.operationId);
      this.accepted.push(operation.operationId);
    }
    // A group accepted later answers the candidates its earlier attempts left.
    for (const conflict of this.conflicts.values()) {
      if (conflict.blockedMutationGroupId === request.mutationGroupId) conflict.open = false;
    }
    const response: PushResponse = {
      status: 'accepted',
      mutationGroupId: request.mutationGroupId,
      acknowledgments: results.map((result) => ({
        operationId: result.operation.operationId,
        entityType: result.operation.entityType,
        entityId: result.operation.entityId,
        serverRevision: result.revision,
      })),
      cursor: String(this.#sequence),
    };
    this.#groupReceipts.set(request.mutationGroupId, clone(response));
    return response;
  }

  async #record(
    operation: PushOperation,
    revision: number,
    deleted: boolean,
    document: Record<string, unknown> | null,
  ): Promise<ServerRecord> {
    return {
      entityType: operation.entityType,
      entityId: operation.entityId,
      revision,
      deleted,
      document: deleted ? null : clone(document),
      hash: deleted || document === null ? null : await this.#hasher.hash(document),
      sequence: 0,
    };
  }

  async #baseMatches(operation: PushOperation, current: ServerRecord): Promise<boolean> {
    if (operation.baseServerRevision !== current.revision) return false;
    if (!this.#verifyHashes || current.document === null) return true;
    return operation.baseSnapshotHash === (await this.#hasher.hash(current.document));
  }

  /** Every live record's references resolve to live records; nothing live refers to a deleted one. */
  #referencesHold(working: ReadonlyMap<string, ServerRecord>): boolean {
    const merged = new Map(this.records);
    for (const [key, record] of working) merged.set(key, record);
    const byId = new Map<string, ServerRecord>();
    for (const record of merged.values()) byId.set(record.entityId, record);
    const check = (record: ServerRecord): boolean => {
      if (record.deleted || record.document === null) return true;
      for (const id of referencedIds(record.document)) {
        if (id === record.entityId) continue;
        const target = byId.get(id);
        if (target === undefined || target.deleted) return false;
      }
      return true;
    };
    for (const record of working.values()) {
      if (!check(record)) return false;
      if (record.deleted) {
        for (const other of merged.values()) {
          if (other.deleted || other.document === null) continue;
          if (referencedIds(other.document).has(record.entityId)) return false;
        }
      }
    }
    return true;
  }

  /* ───────────────────────── Pull ───────────────────────── */

  pull(request: PullRequest): PullResponse {
    const after = request.afterCursor === null ? 0 : Number(request.afterCursor);
    if (this.deletionPending) {
      return { status: 'page', changes: [], nextCursor: String(after), hasMore: false };
    }
    // Older than retained history, or beyond the owner's head: reconcile from the start.
    if (
      request.afterCursor !== null &&
      (after < this.#compactedThrough || after > this.#sequence)
    ) {
      return { status: 'cursor_expired' };
    }
    // Each record appears once, at its latest change (the log keeps only latest states here).
    const waiting = [...this.records.values()]
      .filter((record) => record.sequence > after)
      .sort((left, right) => left.sequence - right.sequence);
    const page = waiting.slice(0, request.limit);
    const changes: PulledChange[] = page.map((record) => ({
      cursor: String(record.sequence),
      entityType: record.entityType,
      entityId: record.entityId,
      serverRevision: record.revision,
      deleted: record.deleted,
      document: record.deleted ? null : clone(record.document),
    }));
    const last = page.at(-1);
    return {
      status: 'page',
      changes,
      nextCursor: String(last === undefined ? Math.max(after, this.#sequence) : last.sequence),
      hasMore: waiting.length > page.length,
    };
  }

  /* ───────────────────────── Conflicts ───────────────────────── */

  closeConflict(request: CloseConflictRequest): { readonly closed: true } {
    const conflict = this.conflicts.get(request.conflictId);
    if (conflict !== undefined) conflict.open = false;
    return { closed: true };
  }

  #nextConflictId(): string {
    this.#conflictCounter += 1;
    return `c0000000-0000-4000-8000-${this.#conflictCounter.toString(16).padStart(12, '0')}`;
  }

  /* ───────────────────────── Transports ───────────────────────── */

  transport(): FakeTransport {
    const calls = { push: 0, pull: 0, openConflicts: 0, closeConflict: 0 };
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const server = this;
    const failure = (mode: FakeTransportMode): TransportResult<never> | null => {
      switch (mode) {
        case 'online':
          return null;
        case 'offline':
          return { ok: false, failure: { kind: 'offline' } };
        case 'unavailable':
          return { ok: false, failure: { kind: 'unavailable', status: 503 } };
        case 'auth_expired':
          return { ok: false, failure: { kind: 'auth_expired' } };
        case 'invalid_response':
          return { ok: false, failure: { kind: 'invalid_response' } };
      }
    };
    const transport: FakeTransport = {
      mode: 'online',
      loseNextPushAnswer: false,
      calls,
      async push(request) {
        calls.push += 1;
        const failed = failure(transport.mode);
        if (failed !== null) return failed;
        const response = await server.push(clone(request));
        if (transport.loseNextPushAnswer) {
          transport.loseNextPushAnswer = false;
          return { ok: false, failure: { kind: 'unavailable', status: 504 } };
        }
        return parsed(pushResponseSchema.safeParse(clone(response)));
      },
      pull(request) {
        calls.pull += 1;
        const failed = failure(transport.mode);
        if (failed !== null) return Promise.resolve(failed);
        const valid = pullRequestSchema.safeParse(clone(request));
        if (!valid.success)
          return Promise.resolve({ ok: false, failure: { kind: 'invalid_response' } });
        return Promise.resolve(
          parsed(pullResponseSchema.safeParse(clone(server.pull(valid.data)))),
        );
      },
      openConflicts() {
        calls.openConflicts += 1;
        const failed = failure(transport.mode);
        if (failed !== null) return Promise.resolve(failed);
        const list = server
          .openConflictList()
          .map((item) => serverConflictSchema.parse(clone(item)));
        return Promise.resolve({ ok: true, value: list });
      },
      closeConflict(request) {
        calls.closeConflict += 1;
        const failed = failure(transport.mode);
        if (failed !== null) return Promise.resolve(failed);
        const valid = closeConflictRequestSchema.safeParse(clone(request));
        if (!valid.success)
          return Promise.resolve({ ok: false, failure: { kind: 'invalid_response' } });
        return Promise.resolve({ ok: true, value: server.closeConflict(valid.data) });
      },
    };
    return transport;
  }
}

function parsed<T>(result: { success: true; data: T } | { success: false }): TransportResult<T> {
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, failure: { kind: 'invalid_response' } };
}

/** Ids a document refers to: UUID values of `…Id` fields at any depth (a reference map stand-in). */
function referencedIds(document: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (/Id$/u.test(key) && typeof item === 'string' && uuidPattern.test(item)) ids.add(item);
        else visit(item);
      }
    }
  };
  visit(document);
  return ids;
}
