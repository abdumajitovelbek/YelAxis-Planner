/**
 * One record against one server candidate: the shared core of
 * applying a pulled change and of answering a push conflict. Equal sides converge; a change only
 * the server made applies with the `sync` actor (no outbox); a change only this device made stays
 * queued; disjoint changes merge when every document validates through its record codec, and the
 * never-applied local operations are rebased onto the remote revision; anything else, including
 * delete versus edit, opens a Conflict that holds this record's groups. A tombstone with no local
 * change deletes permanently through the record's deletion path.
 */
import type { EntityRef, UUID } from '@yelaxis/domain';

import type { CanonicalRecordState } from './contracts';
import type { SyncDocument, SyncRemoteCandidate, SyncServerConflictKind } from './sync-contracts';
import {
  closeConflict,
  deleteRow,
  dropOperations,
  enqueueGroup,
  markConverged,
  openConflict,
  releaseGroups,
  rewriteOperation,
  syncEventTypes,
  updateMutation,
  writeDocument,
  type SyncTransaction,
} from './sync-kit';
import { fieldGroupsFor, mergedDocument, sameDocument, threeWayMerge } from './sync-merge';
import type { SyncStoredOperation } from './sync-ports';

export type ReconcileOutcome = 'unchanged' | 'applied' | 'converged' | 'merged' | 'conflict';

export interface ReconcileOptions {
  /** The server candidate this answers (a push conflict or a server conflict). */
  readonly serverConflictId?: UUID;
  /** The server's kind, used when a conflict opens. */
  readonly serverKind?: SyncServerConflictKind;
  /** The group whose push just conflicted: known not applied; the caller sets its state. */
  readonly pushedGroupId?: UUID;
}

/** A pending operation was sent without a definite answer; it cannot be rewritten yet. */
export class SyncNotReadyError extends Error {
  constructor() {
    super('A sent group has no answer yet.');
    this.name = 'SyncNotReadyError';
  }
}

const groupsOf = (operations: readonly SyncStoredOperation[]): UUID[] => [
  ...new Set(operations.map((operation) => operation.mutationGroupId)),
];

/** Groups whose values differ between two documents (for a merge that did not validate). */
function differingGroups(
  ref: EntityRef,
  local: SyncDocument,
  remote: SyncDocument,
): readonly string[] {
  return fieldGroupsFor(ref.type, [local, remote])
    .filter((group) =>
      group.fields.some(
        (field) => !sameDocument({ value: local[field] }, { value: remote[field] }),
      ),
    )
    .map((group) => group.key);
}

export async function reconcileRecord(
  tx: SyncTransaction,
  ref: EntityRef,
  remote: SyncRemoteCandidate,
  options: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const row = await tx.unitOfWork.records.read(ref);
  const operations = await tx.operationsFor(ref);
  const open = await tx.openConflictFor(ref);
  const answered = options.pushedGroupId !== undefined;

  if (row !== null && row.serverRevision >= remote.serverRevision && !answered) return 'unchanged';
  if (
    operations.some(
      (operation) =>
        operation.mutationGroupId !== options.pushedGroupId &&
        operation.attemptCount > 0 &&
        (operation.state === 'pending' ||
          operation.state === 'retry_wait' ||
          operation.state === 'sending'),
    )
  ) {
    throw new SyncNotReadyError();
  }

  if (row === null) return reconcileMissing(tx, ref, remote, operations, options);

  const snapshot = await tx.unitOfWork.sync.readBaseSnapshot(ref);
  const localChanged = operations.length > 0 || open !== undefined;
  const base =
    snapshot !== null && snapshot.serverRevision === row.serverRevision
      ? snapshot.document
      : localChanged
        ? null
        : row.document;

  if (remote.deleted || remote.document === null) {
    if (!localChanged) {
      await deleteRow(tx, row);
      await tx.unitOfWork.sync.setDeletionServerRevision(ref, remote.serverRevision, tx.now);
      tx.event(ref, syncEventTypes.remoteApplied, 'delete');
      return 'applied';
    }
    if (open !== undefined && remote.serverRevision <= open.remoteServerRevision && !answered) {
      return 'unchanged';
    }
    await openConflict(
      tx,
      {
        ref,
        kind: 'edit_versus_delete',
        origin: 'this_device',
        base,
        local: { deleted: false, document: row.document },
        remote: { deleted: true, document: null },
        remoteServerRevision: remote.serverRevision,
        baseServerRevision: row.serverRevision,
        fields: [],
        ...(options.serverConflictId === undefined
          ? {}
          : { serverConflictId: options.serverConflictId }),
      },
      options.pushedGroupId,
    );
    return 'conflict';
  }

  const remoteDocument = remote.document;
  if (!localChanged) {
    const written = await writeDocument(tx, row, ref, remoteDocument);
    await markConverged(tx, ref, remote.serverRevision, remoteDocument);
    if (written !== null) tx.event(ref, syncEventTypes.remoteApplied, written);
    return written === null ? 'converged' : 'applied';
  }
  if (open !== undefined && remote.serverRevision <= open.remoteServerRevision && !answered) {
    return 'unchanged';
  }

  const merge = threeWayMerge(ref.type, base, row.document, remoteDocument);
  if (merge.status === 'equal' || merge.status === 'remote') {
    // The server already holds the local result, or the local intents cancelled out.
    const written = await writeDocument(tx, row, ref, remoteDocument);
    await markConverged(tx, ref, remote.serverRevision, remoteDocument);
    await dropOperations(tx, ref, operations);
    const released = await closeConflict(tx, ref, 'merge', options.serverConflictId);
    await releaseGroups(tx, [...released, ...groupsOf(operations)], options.pushedGroupId);
    if (written !== null) tx.event(ref, syncEventTypes.remoteApplied, written);
    return written === null ? 'converged' : 'applied';
  }

  if (merge.status !== 'conflict') {
    const merged = mergedDocument(merge, row.document, remoteDocument);
    const rebased =
      merged === null ? null : rebaseOperations(tx, ref, base, operations, remoteDocument);
    if (
      merged !== null &&
      rebased !== null &&
      tx.unitOfWork.sync.validateDocument(ref.type, merged)
    ) {
      await applyMerge(
        tx,
        row,
        ref,
        remote.serverRevision,
        remoteDocument,
        merged,
        rebased,
        options,
      );
      return 'merged';
    }
  }

  await openConflict(
    tx,
    {
      ref,
      kind: options.serverKind ?? 'merge_conflict',
      origin: 'this_device',
      base,
      local: { deleted: false, document: row.document },
      remote: { deleted: false, document: remoteDocument },
      remoteServerRevision: remote.serverRevision,
      baseServerRevision: row.serverRevision,
      fields:
        merge.status === 'conflict'
          ? merge.groups
          : differingGroups(ref, row.document, remoteDocument),
      ...(options.serverConflictId === undefined
        ? {}
        : { serverConflictId: options.serverConflictId }),
    },
    options.pushedGroupId,
  );
  return 'conflict';
}

/** Each never-applied update rebased onto the remote document; null when one cannot be. */
function rebaseOperations(
  tx: SyncTransaction,
  ref: EntityRef,
  base: SyncDocument | null,
  operations: readonly SyncStoredOperation[],
  remote: SyncDocument,
): (readonly [SyncStoredOperation, SyncDocument])[] | null {
  const rebased: (readonly [SyncStoredOperation, SyncDocument])[] = [];
  for (const operation of operations) {
    if (operation.kind !== 'update' || operation.document === null) return null;
    const result = threeWayMerge(ref.type, base, operation.document, remote);
    const document = mergedDocument(result, operation.document, remote);
    if (document === null || !tx.unitOfWork.sync.validateDocument(ref.type, document)) return null;
    rebased.push([operation, document]);
  }
  return rebased;
}

async function applyMerge(
  tx: SyncTransaction,
  row: CanonicalRecordState,
  ref: EntityRef,
  serverRevision: number,
  remote: SyncDocument,
  merged: SyncDocument,
  rebased: readonly (readonly [SyncStoredOperation, SyncDocument])[],
  options: ReconcileOptions,
): Promise<void> {
  const written = await writeDocument(tx, row, ref, merged);
  const hash = await markConverged(tx, ref, serverRevision, remote);
  for (const [operation, document] of rebased) {
    if (!sameDocument(operation.document, document)) {
      await rewriteOperation(tx, operation, { document });
    }
  }
  if (rebased.length === 0 && !sameDocument(merged, remote)) {
    // Only a conflict held the local version: queue the merged document with the remote base.
    const current = await tx.unitOfWork.records.read(ref);
    if (current !== null) {
      await enqueueGroup(tx, [
        updateMutation(ref, current.localRevision, serverRevision, hash, merged),
      ]);
    }
  }
  const released = await closeConflict(tx, ref, 'merge', options.serverConflictId);
  await releaseGroups(
    tx,
    [...released, ...rebased.map(([operation]) => operation.mutationGroupId)],
    options.pushedGroupId,
  );
  if (written !== null) tx.event(ref, syncEventTypes.merged, written);
}

/** The record is not live here: deleted on this replica, or never seen. */
async function reconcileMissing(
  tx: SyncTransaction,
  ref: EntityRef,
  remote: SyncRemoteCandidate,
  operations: readonly SyncStoredOperation[],
  options: ReconcileOptions,
): Promise<ReconcileOutcome> {
  const open = await tx.openConflictFor(ref);
  const deletion = await tx.unitOfWork.sync.readDeletion(ref);
  const answered = options.pushedGroupId !== undefined;

  if (deletion !== null) {
    if (remote.deleted || remote.document === null) {
      // Deleted on both sides: converge, and drop the local intents the server already holds.
      if (remote.serverRevision > deletion.serverRevision) {
        await tx.unitOfWork.sync.setDeletionServerRevision(ref, remote.serverRevision, tx.now);
      }
      await dropOperations(tx, ref, operations);
      const released = await closeConflict(tx, ref, 'keep_deleted', options.serverConflictId);
      await releaseGroups(tx, [...released, ...groupsOf(operations)], options.pushedGroupId);
      return 'converged';
    }
    if (operations.length === 0 && open === undefined) {
      if (remote.serverRevision <= deletion.serverRevision) return 'unchanged';
      // Another device restored the record explicitly after this replica's delete was accepted.
      await tx.unitOfWork.sync.clearDeletion(ref);
      const written = await writeDocument(tx, null, ref, remote.document);
      await markConverged(tx, ref, remote.serverRevision, remote.document);
      if (written !== null) tx.event(ref, syncEventTypes.remoteApplied, written);
      return 'applied';
    }
    if (open !== undefined && remote.serverRevision <= open.remoteServerRevision && !answered) {
      return 'unchanged';
    }
    await openConflict(
      tx,
      {
        ref,
        kind: 'delete_versus_edit',
        origin: 'this_device',
        base: null,
        local: { deleted: true, document: null },
        remote: { deleted: false, document: remote.document },
        remoteServerRevision: remote.serverRevision,
        baseServerRevision: deletion.serverRevision,
        fields: [],
        ...(options.serverConflictId === undefined
          ? {}
          : { serverConflictId: options.serverConflictId }),
      },
      options.pushedGroupId,
    );
    return 'conflict';
  }

  if (remote.deleted || remote.document === null) {
    // A record this replica never held: remember the tombstone so nothing resurrects it.
    await tx.unitOfWork.sync.recordRemoteDeletion(ref, remote.serverRevision, tx.now);
    return 'unchanged';
  }
  const written = await writeDocument(tx, null, ref, remote.document);
  await markConverged(tx, ref, remote.serverRevision, remote.document);
  if (written !== null) tx.event(ref, syncEventTypes.remoteApplied, written);
  return 'applied';
}
