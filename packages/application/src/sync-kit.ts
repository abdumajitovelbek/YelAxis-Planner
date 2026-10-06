/**
 * Shared pieces of the sync use cases: the transaction context, minimized events, record
 * writes through the record codecs, outbox rebasing, and conflict bookkeeping. Every function here
 * runs inside one sync transaction opened by a use case.
 */
import {
  createDeletionTombstone,
  createEntityRef,
  entityRefKey,
  type Clock,
  type CommandActor,
  type CommandContext,
  type EntityRef,
  type EntityType,
  type IdProvider,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import type {
  CanonicalMutation,
  CanonicalRecordState,
  DomainEventRecord,
  OutboxMutationGroup,
} from './contracts';
import type { ProjectionInvalidationPort } from './ports';
import type {
  SyncConflictKind,
  SyncConflictSide,
  SyncDocument,
  SyncResolutionChoice,
} from './sync-contracts';
import { sameDocument } from './sync-merge';
import type {
  SyncConflictPayload,
  SyncDocumentHasher,
  SyncIdentity,
  SyncStoredConflict,
  SyncStoredOperation,
  SyncStorePort,
  SyncUnitOfWork,
} from './sync-ports';

export interface SyncApplicationDependencies {
  readonly store: SyncStorePort;
  readonly clock: Clock;
  readonly ids: IdProvider;
  readonly hasher: SyncDocumentHasher;
  /** Jitter source in [0, 1) for retry backoff; defaults to `Math.random`. */
  readonly random?: () => number;
  /** Told after remote changes and resolutions commit, so views re-query. */
  readonly projections?: ProjectionInvalidationPort;
}

export interface AccountIdentity extends SyncIdentity {
  readonly kind: 'account';
  readonly replicaId: UUID;
}

/** Thrown inside a transaction to roll it back when there is no linked account identity. */
export class SyncNoAccountError extends Error {
  constructor() {
    super('No account identity is active.');
    this.name = 'SyncNoAccountError';
  }
}

export async function requireAccount(unitOfWork: SyncUnitOfWork): Promise<AccountIdentity> {
  const identity = await unitOfWork.sync.identity();
  if (identity === null || identity.kind !== 'account' || identity.replicaId === null) {
    throw new SyncNoAccountError();
  }
  return identity as AccountIdentity;
}

export const syncEventTypes = Object.freeze({
  remoteApplied: 'sync.remote_applied',
  merged: 'sync.merged',
  resolved: 'sync.conflict_resolved',
});

export const entityKey = (type: EntityType, id: string): string => `${type}:${id}`;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Record ids a document refers to (any UUID value at any depth). */
export function referencedIds(document: SyncDocument | null, into: Set<string>): void {
  if (document === null) return;
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (uuidPattern.test(value)) into.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  };
  visit(document);
}

/**
 * Per-transaction state of a sync use case: the context, collected events, touched records, and
 * the tables a reference check has to look at.
 */
export class SyncTransaction {
  readonly context: CommandContext;
  readonly events: DomainEventRecord[] = [];
  readonly touched = new Map<string, EntityRef>();
  readonly written = new Set<EntityType>();
  readonly deleted = new Set<EntityType>();
  queuedPushes = false;
  #operations: Map<string, SyncStoredOperation[]> | null = null;
  #conflicts: Map<string, SyncStoredConflict> | null = null;

  constructor(
    readonly unitOfWork: SyncUnitOfWork,
    readonly identity: AccountIdentity,
    readonly kit: SyncKit,
    actor: CommandActor,
  ) {
    this.context = {
      ownerId: identity.ownerId,
      actor,
      commandId: kit.ids.next(),
      now: kit.clock.now(),
    };
  }

  get ownerId(): OwnerId {
    return this.identity.ownerId;
  }

  get now(): Instant {
    return this.context.now;
  }

  ref(type: EntityType, id: UUID): EntityRef {
    return createEntityRef(type, id, this.ownerId);
  }

  /** Load every unacknowledged operation and open conflict once (bounded by the outbox). */
  async preload(): Promise<void> {
    const operations = new Map<string, SyncStoredOperation[]>();
    let from = 0;
    for (;;) {
      const page = await this.unitOfWork.sync.scanOutbox(this.ownerId, from, 500);
      for (const operation of page) {
        const key = entityKey(operation.entityType, operation.entityId);
        const list = operations.get(key);
        if (list === undefined) operations.set(key, [operation]);
        else list.push(operation);
      }
      const last = page.at(-1);
      if (last === undefined || page.length < 500) break;
      from = last.position + 1;
    }
    this.#operations = operations;
    const conflicts = new Map<string, SyncStoredConflict>();
    for (const conflict of await this.unitOfWork.sync.openConflicts(this.ownerId)) {
      if (conflict.payload.origin !== 'this_device') continue;
      conflicts.set(entityKey(conflict.entityType, conflict.entityId), conflict);
    }
    this.#conflicts = conflicts;
  }

  async operationsFor(ref: EntityRef): Promise<readonly SyncStoredOperation[]> {
    if (this.#operations !== null) return this.#operations.get(entityKey(ref.type, ref.id)) ?? [];
    return this.unitOfWork.sync.operationsForEntity(this.ownerId, ref);
  }

  /**
   * The open conflict this device's own intents are held by. Candidates another device left on the
   * server are separate: they never hold groups and only a person closes them.
   */
  async openConflictFor(ref: EntityRef): Promise<SyncStoredConflict | undefined> {
    if (this.#conflicts !== null) return this.#conflicts.get(entityKey(ref.type, ref.id));
    const all = await this.unitOfWork.sync.openConflicts(this.ownerId);
    return all.find(
      (item) =>
        item.entityType === ref.type &&
        item.entityId === ref.id &&
        item.payload.origin === 'this_device',
    );
  }

  forgetOperations(ref: EntityRef, operationIds: ReadonlySet<string>): void {
    const key = entityKey(ref.type, ref.id);
    const list = this.#operations?.get(key);
    if (list !== undefined) {
      this.#operations?.set(
        key,
        list.filter((operation) => !operationIds.has(operation.operationId)),
      );
    }
  }

  replaceOperation(updated: SyncStoredOperation): void {
    const key = entityKey(updated.entityType, updated.entityId);
    const list = this.#operations?.get(key);
    if (list !== undefined) {
      this.#operations?.set(
        key,
        list.map((operation) =>
          operation.operationId === updated.operationId ? updated : operation,
        ),
      );
    }
  }

  setOpenConflict(ref: EntityRef, conflict: SyncStoredConflict | undefined): void {
    if (this.#conflicts === null) return;
    const key = entityKey(ref.type, ref.id);
    if (conflict === undefined) this.#conflicts.delete(key);
    else this.#conflicts.set(key, conflict);
  }

  hasOpenConflict(type: EntityType, id: string): boolean {
    return this.#conflicts?.has(entityKey(type, id)) ?? false;
  }

  touch(ref: EntityRef): void {
    this.touched.set(entityRefKey(ref), ref);
  }

  event(ref: EntityRef, eventType: string, operation: 'create' | 'update' | 'delete'): void {
    this.touch(ref);
    this.events.push({
      eventId: this.kit.ids.next(),
      ownerId: this.ownerId,
      event: {
        aggregate: ref,
        eventType,
        version: 1,
        actor: this.context.actor,
        commandId: this.context.commandId,
        occurredAt: this.context.now,
        payload: { operation },
      },
    });
  }

  async finishEvents(): Promise<void> {
    if (this.events.length > 0) await this.unitOfWork.events.append(this.events);
  }

  notify(): void {
    const projections = this.kit.projections;
    if (projections === undefined || this.touched.size === 0) return;
    try {
      const result = projections.notifyCommitted({
        commandId: this.context.commandId,
        ownerId: this.ownerId,
        committedAt: this.context.now,
        touched: [...this.touched.values()],
      });
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      // Projections are rebuildable and never fail a committed sync transaction.
    }
  }
}

export interface SyncKit {
  readonly store: SyncStorePort;
  readonly clock: Clock;
  readonly ids: IdProvider;
  readonly hasher: SyncDocumentHasher;
  readonly random: () => number;
  readonly projections: ProjectionInvalidationPort | undefined;
}

export function createSyncKit(dependencies: SyncApplicationDependencies): SyncKit {
  return {
    store: dependencies.store,
    clock: dependencies.clock,
    ids: dependencies.ids,
    hasher: dependencies.hasher,
    random: dependencies.random ?? Math.random,
    projections: dependencies.projections,
  };
}

/* ───────────────────────── Record writes ───────────────────────── */

/**
 * Make a live row hold `document` through its record codec (create, or update when different).
 * Returns the canonical operation written, or null when the row already held it.
 */
export async function writeDocument(
  tx: SyncTransaction,
  row: CanonicalRecordState | null,
  ref: EntityRef,
  document: SyncDocument,
): Promise<'create' | 'update' | null> {
  if (row === null) {
    if (ref.type === 'profile') {
      await tx.unitOfWork.sync.createProfileFromRemote(ref, document, tx.now);
    } else {
      await tx.unitOfWork.records.apply(
        {
          operation: 'create',
          ref,
          expectedRevision: null,
          baseServerRevision: 0,
          baseSnapshotHash: null,
          document,
        },
        tx.context,
      );
    }
    tx.written.add(ref.type);
    return 'create';
  }
  if (sameDocument(row.document, document)) return null;
  await tx.unitOfWork.records.apply(
    {
      operation: 'update',
      ref,
      expectedRevision: row.localRevision,
      baseServerRevision: row.serverRevision,
      baseSnapshotHash: row.baseSnapshotHash,
      document,
    },
    tx.context,
  );
  tx.written.add(ref.type);
  return 'update';
}

/**
 * Permanently delete a live row through its codec's deletion path (content cleared, ledger). That
 * path refuses a record with an open conflict and removes its finished ones, so another device's
 * candidate stays open across it (it becomes a delete-versus-edit choice here), and server
 * candidates still waiting to be closed are remembered again afterwards (without content).
 */
export async function deleteRow(tx: SyncTransaction, row: CanonicalRecordState): Promise<void> {
  const sync = tx.unitOfWork.sync;
  const ofRecord = (conflict: SyncStoredConflict): boolean =>
    conflict.entityType === row.ref.type && conflict.entityId === row.ref.id;
  const waiting = (await sync.conflictsAwaitingClosure(tx.ownerId)).filter(ofRecord);
  const kept = (await sync.openConflicts(tx.ownerId)).filter(
    (conflict) => ofRecord(conflict) && conflict.payload.origin === 'other_device',
  );
  for (const conflict of kept) {
    await sync.updateConflict(tx.ownerId, conflict.conflictId, { state: 'superseded' }, tx.now);
  }
  await tx.unitOfWork.records.apply(
    {
      operation: 'delete',
      ref: row.ref,
      expectedRevision: row.localRevision,
      baseServerRevision: row.serverRevision,
      baseSnapshotHash: row.baseSnapshotHash,
      tombstone: createDeletionTombstone(row.ref, row.localRevision + 1, tx.now),
    },
    tx.context,
  );
  tx.deleted.add(row.ref.type);
  for (const conflict of kept) await sync.insertConflict(tx.ownerId, conflict, tx.now);
  for (const conflict of waiting) {
    const closed = new Set(conflict.payload.closedServerIds ?? []);
    const remaining = conflict.payload.serverConflictIds.filter((id) => !closed.has(id));
    if (remaining.length > 0) {
      await rememberClosure(tx, row.ref, conflict.payload.resolution ?? 'merge', remaining);
    }
  }
}

/** Record that a live row now matches the server at `serverRevision` (base snapshot included). */
export async function markConverged(
  tx: SyncTransaction,
  ref: EntityRef,
  serverRevision: number,
  document: SyncDocument,
): Promise<string> {
  const hash = await tx.kit.hasher.hash(document);
  await tx.unitOfWork.sync.setRecordSyncBase(ref, serverRevision, hash);
  await tx.unitOfWork.sync.writeBaseSnapshot(ref, { serverRevision, hash, document }, tx.now);
  return hash;
}

/** A live row whose server copy is a tombstone (an explicit restore pushes from it). */
export async function markOverTombstone(
  tx: SyncTransaction,
  ref: EntityRef,
  serverRevision: number,
): Promise<void> {
  await tx.unitOfWork.sync.setRecordSyncBase(ref, serverRevision, null);
  await tx.unitOfWork.sync.deleteBaseSnapshot(ref);
}

/* ───────────────────────── Outbox ───────────────────────── */

/** Drop superseded local intents (never sent again). */
export async function dropOperations(
  tx: SyncTransaction,
  ref: EntityRef,
  operations: readonly SyncStoredOperation[],
): Promise<void> {
  if (operations.length === 0) return;
  const ids = operations.map((operation) => operation.operationId);
  await tx.unitOfWork.sync.dropOperations(tx.ownerId, ids, tx.now);
  tx.forgetOperations(ref, new Set(ids));
}

export async function rewriteOperation(
  tx: SyncTransaction,
  operation: SyncStoredOperation,
  update: {
    readonly document?: SyncDocument;
    readonly baseServerRevision?: number;
    readonly baseSnapshotHash?: string | null;
  },
): Promise<void> {
  await tx.unitOfWork.sync.rewriteOperation(tx.ownerId, operation.operationId, update, tx.now);
  tx.replaceOperation({ ...operation, ...update });
}

/** Queue one new group (actor of the transaction) with the given mutations. */
export async function enqueueGroup(
  tx: SyncTransaction,
  mutations: readonly CanonicalMutation[],
): Promise<void> {
  if (mutations.length === 0) return;
  const mutationGroupId = tx.kit.ids.next();
  const group: OutboxMutationGroup = {
    mutationGroupId,
    ownerId: tx.ownerId,
    commandId: tx.context.commandId,
    actor: tx.context.actor,
    createdAt: tx.now,
    operations: mutations.map((mutation, sequence) => ({
      operationId: tx.kit.ids.next(),
      mutationGroupId,
      sequence,
      state: 'pending' as const,
      attemptCount: 0 as const,
      nextAttemptAt: tx.now,
      mutation,
    })),
  };
  await tx.unitOfWork.outbox.append(group);
  tx.queuedPushes = true;
}

export function updateMutation(
  ref: EntityRef,
  localRevision: number,
  serverRevision: number,
  hash: string | null,
  document: SyncDocument,
): CanonicalMutation {
  return {
    operation: 'update',
    ref,
    expectedRevision: localRevision,
    baseServerRevision: serverRevision,
    baseSnapshotHash: hash,
    document,
  };
}

export function deleteMutation(
  ref: EntityRef,
  localRevision: number,
  serverRevision: number,
  hash: string | null,
  now: Instant,
): CanonicalMutation {
  return {
    operation: 'delete',
    ref,
    expectedRevision: localRevision,
    baseServerRevision: serverRevision,
    baseSnapshotHash: hash,
    tombstone: createDeletionTombstone(ref, localRevision + 1, now),
  };
}

/** Hold every group with an operation on a conflicting record (unrelated groups continue). */
export async function blockGroups(
  tx: SyncTransaction,
  operations: readonly SyncStoredOperation[],
  except?: string,
): Promise<readonly UUID[]> {
  const groups = [...new Set(operations.map((operation) => operation.mutationGroupId))];
  for (const groupId of groups) {
    if (groupId === except) continue;
    await tx.unitOfWork.sync.setGroupState(
      tx.ownerId,
      groupId,
      { from: ['pending', 'retry_wait'], state: 'blocked_conflict' },
      tx.now,
    );
  }
  return groups;
}

/** Release held groups whose records no longer have an open conflict. */
export async function releaseGroups(
  tx: SyncTransaction,
  groupIds: Iterable<UUID>,
  except?: string,
): Promise<void> {
  for (const groupId of new Set(groupIds)) {
    if (groupId === except) continue;
    const operations = await tx.unitOfWork.sync.readGroup(tx.ownerId, groupId);
    if (operations.length === 0) continue;
    const held = await anyOpenConflict(tx, operations);
    if (held) continue;
    await tx.unitOfWork.sync.setGroupState(
      tx.ownerId,
      groupId,
      { from: ['blocked_conflict'], state: 'pending', attemptCount: 0, nextAttemptAt: tx.now },
      tx.now,
    );
  }
}

async function anyOpenConflict(
  tx: SyncTransaction,
  operations: readonly SyncStoredOperation[],
): Promise<boolean> {
  for (const operation of operations) {
    const conflict = await tx.openConflictFor(tx.ref(operation.entityType, operation.entityId));
    if (conflict !== undefined) return true;
  }
  return false;
}

/* ───────────────────────── Conflicts ───────────────────────── */

export interface ConflictInput {
  readonly ref: EntityRef;
  readonly kind: SyncConflictKind;
  readonly origin: 'this_device' | 'other_device';
  readonly base: SyncDocument | null;
  readonly local: SyncConflictSide;
  readonly remote: SyncConflictSide;
  readonly remoteServerRevision: number;
  readonly baseServerRevision: number;
  readonly fields: readonly string[];
  readonly serverConflictId?: UUID;
}

const emptySide: SyncConflictSide = { deleted: false, document: null };

/**
 * Open a conflict for a record, superseding an older open one (whose server candidates carry over),
 * and hold every group with an operation on the record.
 */
export async function openConflict(
  tx: SyncTransaction,
  input: ConflictInput,
  heldGroupExcept?: string,
): Promise<SyncStoredConflict> {
  const existing = await tx.openConflictFor(input.ref);
  const carried = new Set<UUID>(existing?.payload.serverConflictIds ?? []);
  if (input.serverConflictId !== undefined) carried.add(input.serverConflictId);
  if (existing !== undefined) {
    await tx.unitOfWork.sync.updateConflict(
      tx.ownerId,
      existing.conflictId,
      {
        state: 'superseded',
        payload: {
          ...existing.payload,
          base: null,
          local: emptySide,
          remote: emptySide,
          serverConflictIds: [],
          closure: 'none',
        },
      },
      tx.now,
    );
  }
  const operations = await tx.operationsFor(input.ref);
  const blockedGroups = await blockGroups(tx, operations, heldGroupExcept);
  const conflict: SyncStoredConflict = {
    conflictId: tx.kit.ids.next(),
    entityType: input.ref.type,
    entityId: input.ref.id,
    kind: input.kind,
    state: 'open',
    baseServerRevision: input.baseServerRevision,
    remoteServerRevision: input.remoteServerRevision,
    createdAt: tx.now,
    payload: {
      v: 1,
      origin: input.origin,
      base: input.base,
      local: input.local,
      remote: input.remote,
      fields: input.fields,
      blockedGroups:
        heldGroupExcept === undefined
          ? blockedGroups
          : [...new Set([...blockedGroups, heldGroupExcept as UUID])],
      serverConflictIds: [...carried],
      closure: 'none',
    },
  };
  await tx.unitOfWork.sync.insertConflict(tx.ownerId, conflict, tx.now);
  tx.setOpenConflict(input.ref, conflict);
  return conflict;
}

/**
 * Close the open conflict of a record (if any) as resolved, plus server candidates that need
 * closing; a resolved row is kept only while a server candidate still has to be closed.
 */
export async function closeConflict(
  tx: SyncTransaction,
  ref: EntityRef,
  resolution: SyncResolutionChoice,
  extraServerConflictId?: UUID,
): Promise<readonly UUID[]> {
  const existing = await tx.openConflictFor(ref);
  const serverIds = new Set<UUID>(existing?.payload.serverConflictIds ?? []);
  if (extraServerConflictId !== undefined) serverIds.add(extraServerConflictId);
  const closure = serverIds.size > 0 ? 'pending' : 'done';
  if (existing !== undefined) {
    await tx.unitOfWork.sync.updateConflict(
      tx.ownerId,
      existing.conflictId,
      {
        state: 'resolved',
        resolutionStrategy: resolution,
        resolvedAt: tx.now,
        payload: resolvedPayload(existing.payload, [...serverIds], closure, resolution),
      },
      tx.now,
    );
    tx.setOpenConflict(ref, undefined);
    return existing.payload.blockedGroups;
  }
  if (serverIds.size > 0) await rememberClosure(tx, ref, resolution, [...serverIds]);
  return [];
}

/**
 * A server candidate answered without a person (an automatic merge, or one that already matches
 * this device): remember only that it must be closed; no candidate content is kept.
 */
export async function rememberClosure(
  tx: SyncTransaction,
  ref: EntityRef,
  resolution: SyncResolutionChoice,
  serverConflictIds: readonly UUID[],
): Promise<void> {
  await tx.unitOfWork.sync.insertConflict(
    tx.ownerId,
    {
      conflictId: tx.kit.ids.next(),
      entityType: ref.type,
      entityId: ref.id,
      kind: 'stale_base',
      state: 'resolved',
      baseServerRevision: 0,
      remoteServerRevision: 0,
      createdAt: tx.now,
      resolutionStrategy: resolution,
      resolvedAt: tx.now,
      payload: {
        v: 1,
        origin: 'this_device',
        base: null,
        local: emptySide,
        remote: emptySide,
        fields: [],
        blockedGroups: [],
        serverConflictIds,
        closure: 'pending',
        resolution,
      },
    },
    tx.now,
  );
}

/** A resolved payload keeps candidates only until every server candidate is closed. */
export function resolvedPayload(
  payload: SyncConflictPayload,
  serverConflictIds: readonly UUID[],
  closure: 'pending' | 'done',
  resolution: SyncResolutionChoice,
): SyncConflictPayload {
  return {
    ...payload,
    serverConflictIds,
    closure,
    resolution,
    ...(closure === 'done' ? { base: null, local: emptySide, remote: emptySide } : {}),
  };
}

export const noContentSide = emptySide;
