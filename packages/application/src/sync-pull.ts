/**
 * Pull side of the sync use cases (sync and conflict contract, pull protocol).
 * Pulled pages apply in ONE transaction that also stores the cursor, so the cursor never passes a
 * change that was not applied, merged, or preserved as a Conflict. A change the local plan cannot
 * hold is preserved as a Conflict instead, so the cursor always moves on and nothing is reset: a
 * document the record codecs refuse is found before anything is written; a refusal they cannot
 * foresee (a constraint, or a reference the pages leave unsatisfied once no more pages wait)
 * restarts the transaction with that change preserved, at most once per change.
 */
import type { EntityType, UUID } from '@yelaxis/domain';

import type {
  SyncPullApplyResult,
  SyncPulledChange,
  SyncPulledPage,
  SyncPullOptions,
} from './sync-contracts';
import {
  entityKey,
  openConflict,
  requireAccount,
  SyncNoAccountError,
  SyncTransaction,
  type SyncKit,
} from './sync-kit';
import { fieldGroupsFor, sameDocument } from './sync-merge';
import { reconcileRecord, SyncNotReadyError, type ReconcileOutcome } from './sync-reconcile';

class ChangeFailed extends Error {
  constructor(readonly index: number) {
    super('A pulled change could not be applied.');
  }
}

class ReferencesUnsatisfied extends Error {
  constructor(readonly culprits: readonly number[]) {
    super('Pulled changes leave references unsatisfied.');
  }
}

interface Tally {
  applied: number;
  merged: number;
  conflicts: number;
  unchanged: number;
}

export async function applyPulledPages(
  kit: SyncKit,
  pages: readonly SyncPulledPage[],
  options: SyncPullOptions = {},
): Promise<SyncPullApplyResult> {
  const last = pages.at(-1);
  if (last === undefined) return { status: 'failed' };
  const changes = pages.flatMap((page) => page.changes);
  // Changes kept as conflicts instead of applied. Every restart adds at least one, so one batch
  // restarts at most once per change.
  const preserved = new Set<number>();
  let screened = false;
  for (;;) {
    let committed: SyncTransaction | null = null;
    try {
      const result = await kit.store.runInTransaction(async (unitOfWork) => {
        const identity = await requireAccount(unitOfWork);
        const counts = await unitOfWork.sync.outboxCounts(identity.ownerId);
        if (counts.unconfirmed > 0) throw new SyncNotReadyError();
        const tx = new SyncTransaction(unitOfWork, identity, kit, 'sync');
        await tx.preload();
        if (!screened) {
          // Before anything is written, so the answer is the same in every attempt.
          for (const [index, change] of changes.entries()) {
            if (await refusedByCodec(tx, change)) preserved.add(index);
          }
          screened = true;
        }
        const tally: Tally = { applied: 0, merged: 0, conflicts: 0, unchanged: 0 };
        for (const [index, change] of changes.entries()) {
          if (preserved.has(index)) {
            await preserveChange(tx, change);
            tally.conflicts += 1;
            continue;
          }
          let outcome: ReconcileOutcome;
          try {
            outcome = await reconcileRecord(tx, tx.ref(change.entityType, change.entityId), {
              serverRevision: change.serverRevision,
              deleted: change.deleted,
              document: change.document,
            });
          } catch (error) {
            // Only a refusal of this record is preserved; a failing store fails the whole page.
            if (error instanceof SyncNotReadyError) throw error;
            if (!unitOfWork.sync.isRecordRefusal(error)) throw error;
            throw new ChangeFailed(index);
          }
          count(tally, outcome);
        }
        const dangling = await unitOfWork.sync.danglingReferences({
          written: [...tx.written],
          deleted: [...tx.deleted],
        });
        if (dangling.length > 0) {
          throw new ReferencesUnsatisfied(culprits(changes, dangling, preserved));
        }
        await tx.finishEvents();
        await unitOfWork.sync.writeCheckpoint(
          identity.ownerId,
          identity.replicaId,
          { cursor: last.nextCursor, ...(last.hasMore ? {} : { lastSuccessAt: tx.now }) },
          tx.now,
        );
        committed = tx;
        return {
          status: 'applied' as const,
          cursor: last.nextCursor,
          caughtUp: !last.hasMore,
          ...tally,
          queuedPushes: tx.queuedPushes,
        };
      });
      (committed as SyncTransaction | null)?.notify();
      return result;
    } catch (error) {
      if (error instanceof SyncNotReadyError) return { status: 'not_ready' };
      if (error instanceof SyncNoAccountError) return { status: 'failed' };
      if (error instanceof ChangeFailed) {
        // A preserved change is never applied, so it cannot fail again; the guard keeps the loop
        // finite whatever a store does.
        if (preserved.has(error.index)) return { status: 'refused' };
        preserved.add(error.index);
        continue;
      }
      if (error instanceof ReferencesUnsatisfied) {
        // A later page may hold what these pages refer to: never preserve while more is waiting.
        if (last.hasMore && options.preserveUnsatisfied !== true) return { status: 'needs_more' };
        const fresh = error.culprits.filter((index) => !preserved.has(index));
        // No pulled change to blame: nothing can be kept as a conflict to let the page through.
        if (fresh.length === 0) return { status: 'refused' };
        for (const index of fresh) preserved.add(index);
        continue;
      }
      return { status: 'failed' };
    }
  }
}

/**
 * True when the change carries a document its record codec refuses and reconciliation would write
 * it as it is. A change this replica already holds is skipped, never written; with local changes
 * the document is compared, and one that cannot be held opens a Conflict instead of being written.
 */
async function refusedByCodec(tx: SyncTransaction, change: SyncPulledChange): Promise<boolean> {
  if (change.deleted || change.document === null) return false;
  if (tx.unitOfWork.sync.validateDocument(change.entityType, change.document)) return false;
  const ref = tx.ref(change.entityType, change.entityId);
  const row = await tx.unitOfWork.records.read(ref);
  const deletion = row === null ? await tx.unitOfWork.sync.readDeletion(ref) : null;
  // A record never held here is written whatever else waits.
  if (row === null && deletion === null) return true;
  if ((await tx.operationsFor(ref)).length > 0 || (await tx.openConflictFor(ref)) !== undefined) {
    return false;
  }
  if (row !== null) return row.serverRevision < change.serverRevision;
  return deletion !== null && deletion.serverRevision < change.serverRevision;
}

function count(tally: Tally, outcome: ReconcileOutcome): void {
  switch (outcome) {
    case 'applied':
      tally.applied += 1;
      return;
    case 'merged':
      tally.merged += 1;
      return;
    case 'conflict':
      tally.conflicts += 1;
      return;
    case 'converged':
    case 'unchanged':
      tally.unchanged += 1;
      return;
  }
}

/**
 * The changes to blame for unsatisfied references: a pulled record that refers to a missing one,
 * or a pulled tombstone of a record something here still refers to.
 */
function culprits(
  changes: readonly SyncPulledChange[],
  dangling: readonly {
    readonly child: { readonly entityType: EntityType; readonly entityId: UUID } | null;
    readonly parent: { readonly entityType: EntityType; readonly entityId: UUID } | null;
  }[],
  preserved: ReadonlySet<number>,
): readonly number[] {
  const lastIndex = new Map<string, number>();
  for (const [index, change] of changes.entries()) {
    if (!preserved.has(index)) lastIndex.set(entityKey(change.entityType, change.entityId), index);
  }
  const blamed = new Set<number>();
  for (const reference of dangling) {
    const parentIndex =
      reference.parent === null
        ? undefined
        : lastIndex.get(entityKey(reference.parent.entityType, reference.parent.entityId));
    if (parentIndex !== undefined && changes[parentIndex]?.deleted === true) {
      blamed.add(parentIndex);
      continue;
    }
    const childIndex =
      reference.child === null
        ? undefined
        : lastIndex.get(entityKey(reference.child.entityType, reference.child.entityId));
    if (childIndex !== undefined) blamed.add(childIndex);
  }
  return [...blamed];
}

/**
 * Keep a change the local plan cannot hold as a Conflict (both candidates preserved); the cursor
 * moves on and this record's local groups are held until a person decides.
 */
async function preserveChange(tx: SyncTransaction, change: SyncPulledChange): Promise<void> {
  const ref = tx.ref(change.entityType, change.entityId);
  const row = await tx.unitOfWork.records.read(ref);
  const deletion = row === null ? await tx.unitOfWork.sync.readDeletion(ref) : null;
  const local =
    row !== null
      ? { deleted: false, document: row.document }
      : { deleted: deletion !== null, document: null };
  const remoteDocument = change.deleted ? null : change.document;
  const fields =
    row === null || remoteDocument === null
      ? []
      : fieldGroupsFor(ref.type, [row.document, remoteDocument])
          .filter((group) =>
            group.fields.some(
              (field) =>
                !sameDocument({ value: row.document[field] }, { value: remoteDocument[field] }),
            ),
          )
          .map((group) => group.key);
  await openConflict(tx, {
    ref,
    kind: change.deleted ? 'edit_versus_delete' : 'merge_conflict',
    origin: 'this_device',
    base: null,
    local,
    remote: { deleted: change.deleted, document: remoteDocument },
    remoteServerRevision: change.serverRevision,
    baseServerRevision: row?.serverRevision ?? deletion?.serverRevision ?? 0,
    fields,
  });
}
