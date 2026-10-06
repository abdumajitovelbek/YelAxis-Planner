/**
 * Conflicts a person resolves (sync and conflict contract, conflict records). A
 * resolution is a new command that makes this device hold the chosen state and, when the server
 * holds something else, pushes it from the server's latest revision; the server candidates close
 * idempotently afterwards. Candidates another device left on the server are shown too.
 */
import type { EntityRef, EntityType, UUID } from '@yelaxis/domain';

import type { CanonicalRecordState } from './contracts';
import type {
  SyncConflictKind,
  SyncConflictSide,
  SyncConflictView,
  SyncDocument,
  SyncPendingClosure,
  SyncResolution,
  SyncResolutionChoice,
  SyncResult,
  SyncServerConflict,
} from './sync-contracts';
import {
  deleteMutation,
  deleteRow,
  dropOperations,
  enqueueGroup,
  markConverged,
  markOverTombstone,
  noContentSide,
  releaseGroups,
  rememberClosure,
  requireAccount,
  resolvedPayload,
  rewriteOperation,
  SyncNoAccountError,
  SyncTransaction,
  syncEventTypes,
  updateMutation,
  writeDocument,
  type SyncKit,
} from './sync-kit';
import { readConflictLinks } from './sync-links';
import { fieldGroupsFor, mergeWithChoices, sameDocument, threeWayMerge } from './sync-merge';
import type { SyncDeletionRecord, SyncStoredConflict, SyncStoredOperation } from './sync-ports';
import { reconcileRecord } from './sync-reconcile';
import { createMutation } from './planning-kit';

/* ───────────────────────── Views ───────────────────────── */

function choicesFor(
  local: SyncConflictSide,
  remote: SyncConflictSide,
): readonly SyncResolutionChoice[] {
  if (local.deleted || remote.deleted) return ['keep_deleted', 'restore_edited'];
  if (local.document === null || remote.document === null) return ['keep_local', 'keep_remote'];
  return ['keep_local', 'keep_remote', 'merge'];
}

function conflictingGroups(
  entityType: EntityType,
  base: SyncDocument | null,
  local: SyncConflictSide,
  remote: SyncConflictSide,
  stored: readonly string[],
): readonly string[] {
  if (local.document === null || remote.document === null) return stored;
  const merge = threeWayMerge(entityType, base, local.document, remote.document);
  if (merge.status === 'conflict') return merge.groups;
  const localDocument = local.document;
  const remoteDocument = remote.document;
  return fieldGroupsFor(entityType, [localDocument, remoteDocument])
    .filter((group) =>
      group.fields.some(
        (field) => !sameDocument({ value: localDocument[field] }, { value: remoteDocument[field] }),
      ),
    )
    .map((group) => group.key);
}

/** The conflict as compared now: this device's current state against the other candidate. */
export function conflictView(
  stored: SyncStoredConflict,
  row: CanonicalRecordState | null,
  deletion: SyncDeletionRecord | null,
): SyncConflictView {
  const local: SyncConflictSide =
    row !== null
      ? { deleted: false, document: row.document }
      : deletion !== null
        ? { deleted: true, document: null }
        : stored.payload.local;
  const remote = stored.payload.remote;
  return {
    conflictId: stored.conflictId,
    entityType: stored.entityType,
    entityId: stored.entityId,
    kind: stored.kind,
    origin: stored.payload.origin,
    createdAt: stored.createdAt,
    base: stored.payload.base,
    local,
    remote,
    fields: conflictingGroups(
      stored.entityType,
      stored.payload.base,
      local,
      remote,
      stored.payload.fields,
    ),
    choices: choicesFor(local, remote),
  };
}

async function viewOf(tx: SyncTransaction, stored: SyncStoredConflict): Promise<SyncConflictView> {
  const ref = tx.ref(stored.entityType, stored.entityId);
  const row = await tx.unitOfWork.records.read(ref);
  const deletion = row === null ? await tx.unitOfWork.sync.readDeletion(ref) : null;
  return conflictView(stored, row, deletion);
}

export async function listConflicts(kit: SyncKit): Promise<readonly SyncConflictView[]> {
  try {
    return await kit.store.runInTransaction(async (unitOfWork) => {
      const identity = await requireAccount(unitOfWork);
      const tx = new SyncTransaction(unitOfWork, identity, kit, 'sync');
      const views: SyncConflictView[] = [];
      for (const stored of await unitOfWork.sync.openConflicts(identity.ownerId)) {
        views.push(await viewOf(tx, stored));
      }
      return views;
    });
  } catch (error) {
    if (error instanceof SyncNoAccountError) return [];
    throw error;
  }
}

export async function getConflict(
  kit: SyncKit,
  conflictId: UUID,
): Promise<SyncConflictView | null> {
  try {
    return await kit.store.runInTransaction(async (unitOfWork) => {
      const identity = await requireAccount(unitOfWork);
      const tx = new SyncTransaction(unitOfWork, identity, kit, 'sync');
      const stored = await unitOfWork.sync.readConflict(identity.ownerId, conflictId);
      if (stored === null || stored.state !== 'open') return null;
      const view = await viewOf(tx, stored);
      const links = await readConflictLinks(tx, [
        view.base,
        view.local.document,
        view.remote.document,
      ]);
      return { ...view, links };
    });
  } catch (error) {
    if (error instanceof SyncNoAccountError) return null;
    throw error;
  }
}

/* ───────────────────────── Resolution ───────────────────────── */

type Target =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'document'; readonly document: SyncDocument }
  /** Keep this device without the other candidate (it never held the record). */
  | { readonly kind: 'absent' };

interface ServerState {
  readonly revision: number;
  readonly deleted: boolean;
  readonly document: SyncDocument | null;
}

class StillReferenced extends Error {
  constructor() {
    super('The record is still used by other records on this device.');
  }
}

function sideTarget(side: SyncConflictSide): Target {
  if (side.deleted) return { kind: 'deleted' };
  return side.document === null
    ? { kind: 'absent' }
    : { kind: 'document', document: side.document };
}

function targetOf(view: SyncConflictView, resolution: SyncResolution): Target | null {
  switch (resolution.choice) {
    case 'keep_local':
      return sideTarget(view.local);
    case 'keep_remote':
      return sideTarget(view.remote);
    case 'keep_deleted':
      return { kind: 'deleted' };
    case 'restore_edited':
      return sideTarget(view.local.deleted ? view.remote : view.local);
    case 'merge': {
      if (view.local.document === null || view.remote.document === null) return null;
      const document = mergeWithChoices(
        view.entityType,
        view.base,
        view.local.document,
        view.remote.document,
        resolution.fields,
      );
      return document === null ? null : { kind: 'document', document };
    }
  }
}

async function serverStateOf(
  tx: SyncTransaction,
  stored: SyncStoredConflict,
  ref: EntityRef,
  row: CanonicalRecordState | null,
  deletion: SyncDeletionRecord | null,
): Promise<ServerState> {
  if (stored.payload.origin === 'this_device' && stored.resolutionStrategy !== 'import_recovery') {
    return {
      revision: stored.remoteServerRevision,
      deleted: stored.payload.remote.deleted,
      document: stored.payload.remote.document,
    };
  }
  // Another device's or an imported recovery candidate grants no server authority. Use only
  // this destination's acknowledged base, so selecting imported content queues a normal write.
  if (row === null) {
    return { revision: deletion?.serverRevision ?? 0, deleted: deletion !== null, document: null };
  }
  if (stored.resolutionStrategy === 'import_recovery' && row.serverRevision === 0) {
    return { revision: 0, deleted: false, document: null };
  }
  const snapshot = await tx.unitOfWork.sync.readBaseSnapshot(ref);
  return {
    revision: row.serverRevision,
    deleted: false,
    document:
      snapshot !== null && snapshot.serverRevision === row.serverRevision
        ? snapshot.document
        : row.document,
  };
}

function sameAsServer(target: Target, server: ServerState): boolean {
  switch (target.kind) {
    case 'deleted':
      return server.deleted;
    case 'absent':
      return true;
    case 'document':
      return !server.deleted && sameDocument(target.document, server.document);
  }
}

export async function resolveConflict(
  kit: SyncKit,
  conflictId: UUID,
  resolution: SyncResolution,
): Promise<SyncResult<{ readonly queued: boolean }>> {
  let committed: SyncTransaction | null = null;
  try {
    const result = await kit.store.runInTransaction(
      async (unitOfWork): Promise<SyncResult<{ readonly queued: boolean }>> => {
        const identity = await requireAccount(unitOfWork);
        const tx = new SyncTransaction(unitOfWork, identity, kit, 'user');
        const stored = await unitOfWork.sync.readConflict(identity.ownerId, conflictId);
        if (stored === null) return { ok: false, code: 'not_found' };
        if (stored.state !== 'open') return { ok: false, code: 'not_open' };
        const ref = tx.ref(stored.entityType, stored.entityId);
        const row = await unitOfWork.records.read(ref);
        const deletion = row === null ? await unitOfWork.sync.readDeletion(ref) : null;
        const view = conflictView(stored, row, deletion);
        if (!view.choices.includes(resolution.choice)) return { ok: false, code: 'invalid_choice' };
        const target = targetOf(view, resolution);
        if (
          target === null ||
          (target.kind === 'document' &&
            !unitOfWork.sync.validateDocument(ref.type, target.document))
        ) {
          return { ok: false, code: 'invalid_merge' };
        }
        const server = await serverStateOf(tx, stored, ref, row, deletion);
        const operations = await tx.operationsFor(ref);
        // A change sent without an answer may already be on the server: it can be neither
        // rewritten nor dropped until its answer arrives.
        if (
          operations.some(
            (operation) => operation.state === 'sending' || operation.attemptCount > 0,
          )
        ) {
          return { ok: false, code: 'not_ready' };
        }

        // The conflict closes first, so the record's deletion path sees nothing holding it.
        const serverIds = stored.payload.serverConflictIds;
        await unitOfWork.sync.updateConflict(
          identity.ownerId,
          stored.conflictId,
          {
            state: 'resolved',
            resolutionStrategy: resolution.choice,
            resolvedAt: tx.now,
            payload: resolvedPayload(
              stored.payload,
              serverIds,
              serverIds.length > 0 ? 'pending' : 'done',
              resolution.choice,
            ),
          },
          tx.now,
        );
        tx.setOpenConflict(ref, undefined);

        const queued = await settle(tx, ref, row, deletion, target, server, operations);
        await releaseGroups(tx, [
          ...stored.payload.blockedGroups,
          ...operations.map((operation) => operation.mutationGroupId),
        ]);
        const dangling = await unitOfWork.sync.danglingReferences({
          written: [...tx.written],
          deleted: [...tx.deleted],
        });
        if (dangling.length > 0) throw new StillReferenced();
        await tx.finishEvents();
        committed = tx;
        return { ok: true, value: { queued } };
      },
    );
    (committed as SyncTransaction | null)?.notify();
    return result;
  } catch (error) {
    if (error instanceof SyncNoAccountError) return { ok: false, code: 'no_account' };
    if (error instanceof StillReferenced) return { ok: false, code: 'still_referenced' };
    return { ok: false, code: 'transaction_failed' };
  }
}

/** Make this device hold `target` and queue what the server still needs. */
async function settle(
  tx: SyncTransaction,
  ref: EntityRef,
  row: CanonicalRecordState | null,
  deletion: SyncDeletionRecord | null,
  target: Target,
  server: ServerState,
  operations: readonly SyncStoredOperation[],
): Promise<boolean> {
  const converged = sameAsServer(target, server);
  const serverHash = server.document === null ? null : await tx.kit.hasher.hash(server.document);

  if (target.kind === 'absent') return false;

  if (target.kind === 'deleted') {
    if (row !== null) {
      await dropOperations(tx, ref, operations);
      await deleteRow(tx, row);
      tx.event(ref, syncEventTypes.resolved, 'delete');
      await tx.unitOfWork.sync.setDeletionServerRevision(ref, server.revision, tx.now);
      if (!converged) {
        await enqueueGroup(tx, [
          deleteMutation(ref, row.localRevision, server.revision, serverHash, tx.now),
        ]);
      }
      return !converged;
    }
    await tx.unitOfWork.sync.setDeletionServerRevision(ref, server.revision, tx.now);
    const pendingDelete = [...operations]
      .reverse()
      .find((operation) => operation.kind === 'delete');
    if (converged || pendingDelete === undefined) {
      await dropOperations(tx, ref, operations);
      if (!converged) {
        const revision = Math.max(1, (deletion?.localRevision ?? 2) - 1);
        await enqueueGroup(tx, [
          deleteMutation(ref, revision, server.revision, serverHash, tx.now),
        ]);
      }
      return !converged;
    }
    await dropOperations(
      tx,
      ref,
      operations.filter((operation) => operation !== pendingDelete),
    );
    await rewriteOperation(tx, pendingDelete, {
      baseServerRevision: server.revision,
      baseSnapshotHash: serverHash,
    });
    return true;
  }

  // The chosen state is a document.
  if (row === null) {
    await tx.unitOfWork.sync.clearDeletion(ref);
    await writeDocument(tx, null, ref, target.document);
    tx.event(ref, syncEventTypes.resolved, 'create');
  } else {
    const written = await writeDocument(tx, row, ref, target.document);
    if (written !== null) tx.event(ref, syncEventTypes.resolved, written);
  }
  if (converged) {
    await markConverged(tx, ref, server.revision, target.document);
    await dropOperations(tx, ref, operations);
    return false;
  }
  if (server.deleted || server.document === null) {
    // Restore edited: an explicit revision over the tombstone, never a hidden overwrite.
    await markOverTombstone(tx, ref, server.revision);
  } else {
    await markConverged(tx, ref, server.revision, server.document);
  }
  if (server.revision === 0 && server.document === null && !server.deleted) {
    const creates = operations.filter((operation) => operation.kind === 'create');
    if (creates.length > 0) {
      // Imported dependency groups must keep their original parent create before dependents.
      // Rewriting a never-sent create preserves that atomic group and its idempotency key.
      await dropOperations(
        tx,
        ref,
        operations.filter((operation) => !['create', 'update'].includes(operation.kind)),
      );
      for (const operation of operations.filter((candidate) =>
        ['create', 'update'].includes(candidate.kind),
      )) {
        if (!sameDocument(operation.document, target.document))
          await rewriteOperation(tx, operation, { document: target.document });
      }
    } else {
      await dropOperations(tx, ref, operations);
      await enqueueGroup(tx, [createMutation(ref, target.document)]);
    }
    return true;
  }
  const updates = operations.filter((operation) => operation.kind === 'update');
  await dropOperations(
    tx,
    ref,
    operations.filter((operation) => operation.kind !== 'update'),
  );
  if (updates.length > 0) {
    // Every queued update now carries the chosen document (none was sent: see the check before),
    // so no version the person did not choose ever reaches the server. Each pushes from the
    // record's latest base when it is claimed.
    for (const update of updates) {
      if (!sameDocument(update.document, target.document)) {
        await rewriteOperation(tx, update, { document: target.document });
      }
    }
    return true;
  }
  const current = await tx.unitOfWork.records.read(ref);
  if (current === null) return false;
  await enqueueGroup(tx, [
    updateMutation(
      ref,
      current.localRevision,
      server.revision,
      server.deleted ? null : serverHash,
      target.document,
    ),
  ]);
  return true;
}

/* ───────────────────────── Server candidates ───────────────────────── */

function otherDeviceKind(conflict: SyncServerConflict, local: SyncConflictSide): SyncConflictKind {
  if (conflict.local.deleted) return 'edit_versus_delete';
  if (local.deleted) return 'delete_versus_edit';
  return conflict.kind === 'create_collision' ? 'create_collision' : 'stale_base';
}

/**
 * Server candidates this replica has not recorded: a lost answer to its own push is handled like
 * the push answer; another device's unsaved candidate becomes a conflict to compare (or closes at
 * once when this device already holds it).
 */
export async function mergeServerConflicts(
  kit: SyncKit,
  conflicts: readonly SyncServerConflict[],
): Promise<number> {
  let committed: SyncTransaction | null = null;
  try {
    const added = await kit.store.runInTransaction(async (unitOfWork) => {
      const identity = await requireAccount(unitOfWork);
      const tx = new SyncTransaction(unitOfWork, identity, kit, 'sync');
      let opened = 0;
      for (const conflict of conflicts) {
        const known = await unitOfWork.sync.conflictsForServerId(
          identity.ownerId,
          conflict.serverConflictId,
        );
        if (known.length > 0) continue;
        const ref = tx.ref(conflict.entityType, conflict.entityId);
        const group = await unitOfWork.sync.readGroup(
          identity.ownerId,
          conflict.blockedMutationGroupId,
        );
        const first = group[0];
        if (first !== undefined) {
          if (first.state === 'sending') continue;
          const outcome = await reconcileRecord(tx, ref, conflict.remote, {
            serverConflictId: conflict.serverConflictId,
            serverKind: conflict.kind,
            pushedGroupId: first.mutationGroupId,
          });
          const remaining = await unitOfWork.sync.readGroup(
            identity.ownerId,
            first.mutationGroupId,
          );
          if (remaining.length > 0) {
            await unitOfWork.sync.setGroupState(
              identity.ownerId,
              first.mutationGroupId,
              outcome === 'conflict'
                ? {
                    from: ['pending', 'retry_wait', 'dead_letter'],
                    state: 'blocked_conflict',
                    attemptCount: 0,
                  }
                : {
                    from: ['pending', 'retry_wait'],
                    state: 'pending',
                    attemptCount: 0,
                    nextAttemptAt: tx.now,
                  },
              tx.now,
            );
          }
          if (outcome === 'conflict') opened += 1;
          continue;
        }
        const row = await unitOfWork.records.read(ref);
        const deletion = row === null ? await unitOfWork.sync.readDeletion(ref) : null;
        const local: SyncConflictSide =
          row !== null
            ? { deleted: false, document: row.document }
            : { deleted: deletion !== null, document: null };
        const candidate: SyncConflictSide = conflict.local.deleted
          ? { deleted: true, document: null }
          : { deleted: false, document: conflict.local.document };
        const matches = candidate.deleted
          ? local.deleted
          : !local.deleted &&
            local.document !== null &&
            sameDocument(local.document, candidate.document);
        if (matches) {
          await rememberClosure(tx, ref, 'keep_local', [conflict.serverConflictId]);
          continue;
        }
        const snapshot = row === null ? null : await unitOfWork.sync.readBaseSnapshot(ref);
        const base =
          row !== null && snapshot !== null && snapshot.serverRevision === row.serverRevision
            ? snapshot.document
            : null;
        await unitOfWork.sync.insertConflict(
          identity.ownerId,
          {
            conflictId: kit.ids.next(),
            entityType: ref.type,
            entityId: ref.id,
            kind: otherDeviceKind(conflict, local),
            state: 'open',
            baseServerRevision: conflict.baseServerRevision,
            remoteServerRevision: row?.serverRevision ?? deletion?.serverRevision ?? 0,
            createdAt: tx.now,
            payload: {
              v: 1,
              origin: 'other_device',
              base,
              local,
              remote: candidate,
              fields: conflictingGroups(ref.type, base, local, candidate, []),
              blockedGroups: [],
              serverConflictIds: [conflict.serverConflictId],
              closure: 'none',
            },
          },
          tx.now,
        );
        opened += 1;
      }
      // Another device's candidate that is no longer open was answered elsewhere.
      const stillOpen = new Set<string>(conflicts.map((conflict) => conflict.serverConflictId));
      for (const stored of await unitOfWork.sync.openConflicts(identity.ownerId)) {
        if (stored.payload.origin !== 'other_device') continue;
        if (stored.payload.serverConflictIds.some((id) => stillOpen.has(id))) continue;
        await unitOfWork.sync.updateConflict(
          identity.ownerId,
          stored.conflictId,
          {
            state: 'superseded',
            payload: {
              ...stored.payload,
              base: null,
              local: noContentSide,
              remote: noContentSide,
              closure: 'done',
            },
          },
          tx.now,
        );
      }
      await tx.finishEvents();
      committed = tx;
      return opened;
    });
    (committed as SyncTransaction | null)?.notify();
    return added;
  } catch (error) {
    if (error instanceof SyncNoAccountError) return 0;
    throw error;
  }
}

export async function pendingServerClosures(kit: SyncKit): Promise<readonly SyncPendingClosure[]> {
  try {
    return await kit.store.runInTransaction(async (unitOfWork) => {
      const identity = await requireAccount(unitOfWork);
      const closures: SyncPendingClosure[] = [];
      for (const stored of await unitOfWork.sync.conflictsAwaitingClosure(identity.ownerId)) {
        const closed = new Set(stored.payload.closedServerIds ?? []);
        for (const serverConflictId of stored.payload.serverConflictIds) {
          if (closed.has(serverConflictId)) continue;
          closures.push({
            serverConflictId,
            resolution: stored.payload.resolution ?? 'merge',
          });
        }
      }
      return closures;
    });
  } catch (error) {
    if (error instanceof SyncNoAccountError) return [];
    throw error;
  }
}

/** One server candidate is closed; candidates are cleared once every one is. Idempotent. */
export async function confirmServerClosure(kit: SyncKit, serverConflictId: UUID): Promise<void> {
  try {
    await kit.store.runInTransaction(async (unitOfWork) => {
      const identity = await requireAccount(unitOfWork);
      const now = kit.clock.now();
      for (const stored of await unitOfWork.sync.conflictsForServerId(
        identity.ownerId,
        serverConflictId,
      )) {
        if (stored.state !== 'resolved') continue;
        const closed = [...new Set([...(stored.payload.closedServerIds ?? []), serverConflictId])];
        const done = stored.payload.serverConflictIds.every((id) => closed.includes(id));
        await unitOfWork.sync.updateConflict(
          identity.ownerId,
          stored.conflictId,
          {
            payload: {
              ...stored.payload,
              closedServerIds: closed,
              closure: done ? 'done' : 'pending',
              ...(done ? { base: null, local: noContentSide, remote: noContentSide } : {}),
            },
          },
          now,
        );
      }
    });
  } catch (error) {
    if (error instanceof SyncNoAccountError) return;
    throw error;
  }
}
