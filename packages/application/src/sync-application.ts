/**
 * synchronization facade. The application owns every sync write: one
 * transaction per use case, serialized on the queue the composition root shares with the other
 * facades (the browser owns one SQLite worker connection). Network work never happens here; the
 * sync coordinator calls these use cases between transport calls, so commands never wait on it.
 */
import type { UUID } from '@yelaxis/domain';

import { createSerialQueue, serializeMethods, type SerialQueue } from './planning-kit';
import {
  confirmServerClosure,
  getConflict,
  listConflicts,
  mergeServerConflicts,
  pendingServerClosures,
  resolveConflict,
} from './sync-conflicts';
import type {
  SyncApplication,
  SyncFacts,
  SyncPulledPage,
  SyncPullOptions,
  SyncPushOutcome,
  SyncResolution,
  SyncServerConflict,
} from './sync-contracts';
import {
  createSyncKit,
  requireAccount,
  SyncNoAccountError,
  type SyncApplicationDependencies,
  type SyncKit,
} from './sync-kit';
import { applyPulledPages } from './sync-pull';
import { claimNextGroup, recordPushOutcome } from './sync-push';

export type { SyncApplicationDependencies } from './sync-kit';

const noFacts: SyncFacts = {
  link: 'none',
  deletion: 'none',
  pending: 0,
  sending: 0,
  waiting: 0,
  blocked: 0,
  rejected: 0,
  unconfirmed: 0,
  openConflicts: 0,
  cursor: null,
};

async function readFacts(kit: SyncKit): Promise<SyncFacts> {
  return kit.store.runInTransaction(async (unitOfWork) => {
    const identity = await unitOfWork.sync.identity();
    if (identity === null) return noFacts;
    if (identity.kind === 'local') return { ...noFacts, link: 'local', ownerId: identity.ownerId };
    const ownerId = identity.ownerId;
    const counts = await unitOfWork.sync.outboxCounts(ownerId);
    const conflicts = await unitOfWork.sync.openConflicts(ownerId);
    const checkpoint =
      identity.replicaId === null
        ? { cursor: null, lastSuccessAt: null }
        : await unitOfWork.sync.readCheckpoint(ownerId, identity.replicaId);
    const progress = identity.linked ? null : await unitOfWork.sync.uploadProgress(ownerId);
    return {
      link: identity.linked ? 'linked' : 'linking',
      ownerId,
      ...(identity.replicaId === null ? {} : { replicaId: identity.replicaId }),
      deletion: identity.deletion,
      pending: counts.byState.pending ?? 0,
      sending: counts.byState.sending ?? 0,
      waiting: counts.byState.retry_wait ?? 0,
      ...(counts.nextAttemptAt === null ? {} : { nextAttemptAt: counts.nextAttemptAt }),
      blocked: counts.byState.blocked_conflict ?? 0,
      rejected: counts.byState.dead_letter ?? 0,
      unconfirmed: counts.unconfirmed,
      openConflicts: conflicts.length,
      ...(checkpoint.lastSuccessAt === null ? {} : { lastSuccessAt: checkpoint.lastSuccessAt }),
      cursor: checkpoint.cursor,
      ...(progress === null ? {} : { firstUpload: progress }),
    } satisfies SyncFacts;
  });
}

interface StateMove {
  readonly from: 'sending' | 'retry_wait' | 'dead_letter';
  readonly state: 'pending' | 'retry_wait';
  readonly resetAttempts?: boolean;
}

async function moveStates(kit: SyncKit, update: StateMove): Promise<number> {
  try {
    return await kit.store.runInTransaction(async (unitOfWork) => {
      const identity = await requireAccount(unitOfWork);
      const now = kit.clock.now();
      return unitOfWork.sync.setStateWhere(
        identity.ownerId,
        {
          from: update.from,
          state: update.state,
          nextAttemptAt: now,
          ...(update.resetAttempts === true ? { resetAttempts: true } : {}),
        },
        now,
      );
    });
  } catch (error) {
    if (error instanceof SyncNoAccountError) return 0;
    throw error;
  }
}

async function restartFromBeginning(kit: SyncKit): Promise<void> {
  try {
    await kit.store.runInTransaction(async (unitOfWork) => {
      const identity = await requireAccount(unitOfWork);
      const now = kit.clock.now();
      // Only the cursor goes back; every local record and queued change stays.
      await unitOfWork.sync.writeCheckpoint(
        identity.ownerId,
        identity.replicaId,
        { cursor: null },
        now,
      );
    });
  } catch (error) {
    if (error instanceof SyncNoAccountError) return;
    throw error;
  }
}

export function createSyncApplication(
  dependencies: SyncApplicationDependencies,
  options: { readonly queue?: SerialQueue } = {},
): SyncApplication {
  const kit = createSyncKit(dependencies);
  const application: SyncApplication = {
    facts: () => readFacts(kit),
    recoverStranded: () => moveStates(kit, { from: 'sending', state: 'pending' }),
    retryNow: () => moveStates(kit, { from: 'retry_wait', state: 'retry_wait' }),
    retryRejected: () =>
      moveStates(kit, { from: 'dead_letter', state: 'pending', resetAttempts: true }),
    claimNextGroup: () => claimNextGroup(kit),
    recordPushOutcome: (mutationGroupId: UUID, outcome: SyncPushOutcome) =>
      recordPushOutcome(kit, mutationGroupId, outcome),
    applyPulledPages: (pages: readonly SyncPulledPage[], pullOptions?: SyncPullOptions) =>
      applyPulledPages(kit, pages, pullOptions),
    restartFromBeginning: () => restartFromBeginning(kit),
    mergeServerConflicts: (conflicts: readonly SyncServerConflict[]) =>
      mergeServerConflicts(kit, conflicts),
    pendingServerClosures: () => pendingServerClosures(kit),
    confirmServerClosure: (serverConflictId: UUID) => confirmServerClosure(kit, serverConflictId),
    listConflicts: () => listConflicts(kit),
    getConflict: (conflictId: UUID) => getConflict(kit, conflictId),
    resolveConflict: (conflictId: UUID, resolution: SyncResolution) =>
      resolveConflict(kit, conflictId, resolution),
  };
  return serializeMethods(application, options.queue ?? createSerialQueue());
}
