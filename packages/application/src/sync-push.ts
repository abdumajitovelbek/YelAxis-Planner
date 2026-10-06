/**
 * Push side of the sync use cases: claim the next ready group in local order and record what
 * the server answered (sync and conflict contract, push protocol and retry
 * policy). One transaction per use case; operation ids never change.
 */
import { createEntityRef, type Instant, type OwnerId, type UUID } from '@yelaxis/domain';

import { syncBackoffDelay } from './sync-backoff';
import type {
  SyncOutgoingGroup,
  SyncOutgoingOperation,
  SyncPushConflict,
  SyncPushOutcome,
  SyncPushRecordResult,
} from './sync-contracts';
import {
  entityKey,
  markConverged,
  referencedIds,
  requireAccount,
  SyncNoAccountError,
  SyncTransaction,
  type SyncKit,
} from './sync-kit';
import type { SyncStoredOperation, SyncUnitOfWork } from './sync-ports';
import { reconcileRecord } from './sync-reconcile';

const scanPageSize = 200;

export function instantAfter(now: Instant, milliseconds: number): Instant {
  return new Date(Date.parse(now) + milliseconds).toISOString() as Instant;
}

function isDue(operation: SyncStoredOperation, now: Instant): boolean {
  if (operation.state === 'pending') return true;
  if (operation.state !== 'retry_wait') return false;
  return operation.nextAttemptAt === null || Date.parse(operation.nextAttemptAt) <= Date.parse(now);
}

/** One unclaimed group as the claim order sees it. */
interface GroupShape {
  readonly keys: readonly string[];
  readonly ids: readonly string[];
  /** Records the group refers to, other than its own. */
  readonly references: ReadonlySet<string>;
  /** Sent before without a definite answer: the server may already hold it. */
  readonly sent: boolean;
  /** Rejected (`dead_letter`) or held by a conflict (`blocked_conflict`): a person decides. */
  readonly forPerson: boolean;
}

function shapeOf(operations: readonly SyncStoredOperation[]): GroupShape {
  const references = new Set<string>();
  for (const operation of operations) referencedIds(operation.document, references);
  for (const operation of operations) references.delete(operation.entityId);
  return {
    keys: operations.map((operation) => entityKey(operation.entityType, operation.entityId)),
    ids: operations.map((operation) => operation.entityId),
    references,
    sent: operations.some((operation) => operation.attemptCount > 0),
    forPerson: operations.some(
      (operation) => operation.state === 'dead_letter' || operation.state === 'blocked_conflict',
    ),
  };
}

/** What open conflicts and the earlier unclaimed groups of one scan hold back. */
class ClaimOrder {
  /** Records with an open conflict of this device. */
  readonly #conflictKeys = new Set<string>();
  readonly #conflictIds = new Set<string>();
  /** Records touched by earlier unclaimed groups. */
  readonly #earlierKeys = new Set<string>();
  readonly #earlierIds = new Set<string>();
  /** Records touched by earlier groups that wait for a person (see `#waitsForPerson`). */
  readonly #personKeys = new Set<string>();
  readonly #personIds = new Set<string>();
  /** Records that earlier groups on their way to the server (not waiting for a person) need. */
  readonly #needed = new Set<string>();

  conflict(key: string, id: string): void {
    this.#conflictKeys.add(key);
    this.#conflictIds.add(id);
  }

  onConflict(group: GroupShape): boolean {
    return group.keys.some((key) => this.#conflictKeys.has(key));
  }

  holds(group: GroupShape): boolean {
    // Each record's changes reach the server in the order they were made.
    if (group.keys.some((key) => this.#earlierKeys.has(key))) return true;
    // A group sent before is sent again with the same ids, whatever else waits: the server may
    // already hold it, and pulls wait for every such group, so it must never wait on a person.
    if (group.sent) return false;
    return (
      this.onConflict(group) ||
      [...group.references].some((id) => this.#earlierIds.has(id) || this.#conflictIds.has(id)) ||
      group.ids.some((id) => this.#needed.has(id))
    );
  }

  /**
   * A group waits for a person when it is rejected or held by a conflict, or when it can only
   * follow such a group: one on the same record, or one whose record it refers to.
   */
  #waitsForPerson(group: GroupShape): boolean {
    if (group.forPerson || group.keys.some((key) => this.#personKeys.has(key))) return true;
    if (group.sent) return false;
    return (
      this.onConflict(group) ||
      [...group.references].some((id) => this.#personIds.has(id) || this.#conflictIds.has(id))
    );
  }

  /** A group the scan passed without claiming it. */
  passed(group: GroupShape): void {
    if (this.#waitsForPerson(group)) {
      for (const key of group.keys) this.#personKeys.add(key);
      for (const id of group.ids) this.#personIds.add(id);
    } else {
      for (const id of group.references) this.#needed.add(id);
    }
    for (const key of group.keys) this.#earlierKeys.add(key);
    for (const id of group.ids) this.#earlierIds.add(id);
  }
}

/**
 * The next ready group in local order, marked `sending`. Local order holds a group back while:
 *
 * - an earlier unclaimed group (in any state) touches one of its records;
 * - for a group never sent: one of its records has an open conflict (it is then marked
 * `blocked_conflict`); it refers to a record with an open conflict or to a record an earlier
 * unclaimed group touches; or an earlier group on its way to the server refers to one of its
 * records (so a later change, such as a delete, never overtakes a change that needs the record).
 *
 * A group sent before without a definite answer is never held by conflicts or references: it is
 * sent again with the same ids, so pulls, which wait for it, always resume.
 *
 * A rejected group (`dead_letter`) waits for a person's retry, and a group held by a conflict for
 * a resolution. Either holds back only later groups on its own records and later groups that refer
 * to them (and so on, for groups that can only follow those). The records such waiting groups
 * merely refer to stay free: a later change to them continues, and if the waiting change is retried
 * or resolved, the server answers it again (a resolution rewrites the conflicting record's changes).
 */
export async function claimNextGroup(kit: SyncKit): Promise<SyncOutgoingGroup | null> {
  try {
    return await kit.store.runInTransaction(async (unitOfWork) => {
      const identity = await requireAccount(unitOfWork);
      if (identity.deletion === 'pending') return null;
      const ownerId = identity.ownerId;
      const now = kit.clock.now();
      const order = new ClaimOrder();
      for (const conflict of await unitOfWork.sync.openConflicts(ownerId)) {
        if (conflict.payload.origin !== 'this_device') continue;
        order.conflict(entityKey(conflict.entityType, conflict.entityId), conflict.entityId);
      }
      const seen = new Set<string>();
      let from = 0;
      for (;;) {
        const page = await unitOfWork.sync.scanOutbox(ownerId, from, scanPageSize);
        for (const row of page) {
          if (seen.has(row.mutationGroupId)) continue;
          seen.add(row.mutationGroupId);
          const operations = await unitOfWork.sync.readGroup(ownerId, row.mutationGroupId);
          const first = operations[0];
          if (first === undefined) continue;
          const group = shapeOf(operations);
          const due = operations.every((operation) => isDue(operation, now));
          if (due && !order.holds(group)) {
            return claim(unitOfWork, ownerId, identity.replicaId, operations, now);
          }
          if (due && !group.sent && order.onConflict(group)) {
            await unitOfWork.sync.setGroupState(
              ownerId,
              first.mutationGroupId,
              { from: ['pending', 'retry_wait'], state: 'blocked_conflict' },
              now,
            );
          }
          order.passed(group);
        }
        const last = page.at(-1);
        if (last === undefined || page.length < scanPageSize) return null;
        from = last.position + 1;
      }
    });
  } catch (error) {
    if (error instanceof SyncNoAccountError) return null;
    throw error;
  }
}

async function claim(
  unitOfWork: SyncUnitOfWork,
  ownerId: OwnerId,
  replicaId: UUID,
  operations: readonly SyncStoredOperation[],
  now: Instant,
): Promise<SyncOutgoingGroup> {
  const first = operations[0];
  if (first === undefined) throw new Error('A claimed group has operations.');
  const attempt = first.attemptCount + 1;
  await unitOfWork.sync.setGroupState(
    ownerId,
    first.mutationGroupId,
    { from: [first.state], state: 'sending', attemptCount: attempt },
    now,
  );
  const outgoing: SyncOutgoingOperation[] = [];
  for (const [sequence, operation] of operations.entries()) {
    let baseServerRevision = operation.baseServerRevision;
    let baseSnapshotHash = operation.baseSnapshotHash;
    if (operation.kind === 'create') {
      baseServerRevision = 0;
      baseSnapshotHash = null;
    } else if (operation.kind === 'update') {
      // Bases follow the record: an earlier acknowledgment or a rebase moved them forward.
      const row = await unitOfWork.records.read(
        createEntityRef(operation.entityType, operation.entityId, ownerId),
      );
      if (row !== null) {
        baseServerRevision = row.serverRevision;
        baseSnapshotHash = row.baseSnapshotHash;
      }
    }
    outgoing.push({
      operationId: operation.operationId,
      sequence,
      entityType: operation.entityType,
      entityId: operation.entityId,
      kind: operation.kind,
      baseServerRevision,
      baseSnapshotHash,
      document: operation.kind === 'delete' ? null : operation.document,
    });
  }
  return { mutationGroupId: first.mutationGroupId, replicaId, attempt, operations: outgoing };
}

/** Record the server's answer for one `sending` group in one transaction. */
export async function recordPushOutcome(
  kit: SyncKit,
  mutationGroupId: UUID,
  outcome: SyncPushOutcome,
): Promise<SyncPushRecordResult> {
  let committed: SyncTransaction | null = null;
  let result: SyncPushRecordResult;
  try {
    result = await kit.store.runInTransaction(async (unitOfWork) => {
      const identity = await requireAccount(unitOfWork);
      const tx = new SyncTransaction(unitOfWork, identity, kit, 'sync');
      const operations = await unitOfWork.sync.readGroup(identity.ownerId, mutationGroupId);
      if (operations.length === 0 || operations.some((item) => item.state !== 'sending')) {
        return { status: 'stale' } as const;
      }
      const answer = await recordAnswer(tx, operations, outcome);
      await tx.finishEvents();
      committed = tx;
      return answer;
    });
  } catch (error) {
    if (error instanceof SyncNoAccountError) return { status: 'stale' };
    throw error;
  }
  (committed as SyncTransaction | null)?.notify();
  return result;
}

async function recordAnswer(
  tx: SyncTransaction,
  operations: readonly SyncStoredOperation[],
  outcome: SyncPushOutcome,
): Promise<SyncPushRecordResult> {
  const first = operations[0];
  if (first === undefined) return { status: 'stale' };
  const groupId = first.mutationGroupId;
  const attempt = first.attemptCount;
  switch (outcome.kind) {
    case 'accepted':
      return acknowledge(tx, operations, outcome.acknowledgments);
    case 'transient':
      return waitAndRetry(tx, groupId, attempt);
    case 'auth_expired':
    case 'deletion_pending':
      // Refused before anything was applied: the same group waits, unchanged, for the session.
      await tx.unitOfWork.sync.setGroupState(
        tx.ownerId,
        groupId,
        {
          from: ['sending'],
          state: 'pending',
          attemptCount: Math.max(0, attempt - 1),
          nextAttemptAt: tx.now,
        },
        tx.now,
      );
      return { status: 'paused' };
    case 'rejected':
      // Schema, ownership, reference, or limit: never retried blindly (Needs attention).
      await tx.unitOfWork.sync.setGroupState(
        tx.ownerId,
        groupId,
        { from: ['sending'], state: 'dead_letter', attemptCount: 0 },
        tx.now,
      );
      return { status: 'dead_letter' };
    case 'conflict':
      return answerConflicts(tx, operations, outcome.conflicts);
  }
}

async function waitAndRetry(
  tx: SyncTransaction,
  groupId: UUID,
  attempt: number,
): Promise<SyncPushRecordResult> {
  const nextAttemptAt = instantAfter(tx.now, syncBackoffDelay(attempt, tx.kit.random));
  await tx.unitOfWork.sync.setGroupState(
    tx.ownerId,
    groupId,
    { from: ['sending'], state: 'retry_wait', nextAttemptAt },
    tx.now,
  );
  return { status: 'retry_wait', nextAttemptAt };
}

/**
 * Accepted: every record takes its new server revision and base snapshot, every later queued
 * operation on those records is rebased onto them (it was made from this group's result), and the
 * group's rows are removed (an acknowledged operation is never sent again).
 */
async function acknowledge(
  tx: SyncTransaction,
  operations: readonly SyncStoredOperation[],
  acknowledgments: Extract<SyncPushOutcome, { kind: 'accepted' }>['acknowledgments'],
): Promise<SyncPushRecordResult> {
  const byOperation = new Map(acknowledgments.map((item) => [item.operationId, item]));
  const complete = operations.every((operation) => {
    const acknowledgment = byOperation.get(operation.operationId);
    return (
      acknowledgment !== undefined &&
      acknowledgment.entityType === operation.entityType &&
      acknowledgment.entityId === operation.entityId &&
      Number.isSafeInteger(acknowledgment.serverRevision) &&
      acknowledgment.serverRevision >= 1
    );
  });
  const first = operations[0];
  if (first === undefined) return { status: 'stale' };
  if (!complete) return waitAndRetry(tx, first.mutationGroupId, first.attemptCount);

  const bases: {
    entityType: SyncStoredOperation['entityType'];
    entityId: UUID;
    serverRevision: number;
    hash: string | null;
  }[] = [];
  for (const operation of operations) {
    const serverRevision = byOperation.get(operation.operationId)?.serverRevision ?? 0;
    const ref = tx.ref(operation.entityType, operation.entityId);
    const base = { entityType: operation.entityType, entityId: operation.entityId, serverRevision };
    if (operation.kind === 'delete' || operation.document === null) {
      await tx.unitOfWork.sync.setDeletionServerRevision(ref, serverRevision, tx.now);
      await tx.unitOfWork.sync.deleteBaseSnapshot(ref);
      bases.push({ ...base, hash: null });
      continue;
    }
    const row = await tx.unitOfWork.records.read(ref);
    if (row !== null) {
      bases.push({
        ...base,
        hash: await markConverged(tx, ref, serverRevision, operation.document),
      });
      continue;
    }
    // Deleted here after this operation was queued: the queued delete pushes from this revision.
    await tx.unitOfWork.sync.setDeletionServerRevision(ref, serverRevision, tx.now);
    bases.push({ ...base, hash: await tx.kit.hasher.hash(operation.document) });
  }
  await tx.unitOfWork.sync.acknowledgeOperations(
    tx.ownerId,
    operations.map((operation) => operation.operationId),
    tx.now,
  );
  await tx.unitOfWork.sync.rebaseQueuedOperations(tx.ownerId, bases, tx.now);
  return { status: 'acknowledged' };
}

/**
 * Conflict: nothing was applied. Each conflicting record is reconciled against the server's
 * candidate; disjoint changes merge and the group is ready again, anything else holds it.
 */
async function answerConflicts(
  tx: SyncTransaction,
  operations: readonly SyncStoredOperation[],
  conflicts: readonly SyncPushConflict[],
): Promise<SyncPushRecordResult> {
  const first = operations[0];
  if (first === undefined) return { status: 'stale' };
  const groupId = first.mutationGroupId;
  let answered = 0;
  let open = 0;
  for (const conflict of conflicts) {
    const operation =
      operations.find((item) => item.operationId === conflict.operationId) ??
      operations.find(
        (item) => item.entityType === conflict.entityType && item.entityId === conflict.entityId,
      );
    if (operation === undefined) continue;
    answered += 1;
    const outcome = await reconcileRecord(
      tx,
      tx.ref(operation.entityType, operation.entityId),
      conflict.remote,
      {
        serverConflictId: conflict.serverConflictId,
        serverKind: conflict.kind,
        pushedGroupId: groupId,
      },
    );
    if (outcome === 'conflict') open += 1;
  }
  if (answered === 0) return waitAndRetry(tx, groupId, first.attemptCount);

  const remaining = await tx.unitOfWork.sync.readGroup(tx.ownerId, groupId);
  if (remaining.length === 0) return { status: 'merged' };
  let held = open > 0;
  for (const operation of remaining) {
    if (held) break;
    held =
      (await tx.openConflictFor(tx.ref(operation.entityType, operation.entityId))) !== undefined;
  }
  await tx.unitOfWork.sync.setGroupState(
    tx.ownerId,
    groupId,
    held
      ? { from: ['sending'], state: 'blocked_conflict', attemptCount: 0 }
      : { from: ['sending'], state: 'pending', attemptCount: 0, nextAttemptAt: tx.now },
    tx.now,
  );
  return held ? { status: 'blocked', conflicts: open } : { status: 'merged' };
}
