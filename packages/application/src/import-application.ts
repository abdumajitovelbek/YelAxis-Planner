import {
  createDeletionTombstone,
  createEntityRef,
  type EntityRef,
  type UUID,
} from '@yelaxis/domain';

import type { EncodedBundle } from './account-contracts';
import type {
  CanonicalMutation,
  CommandReceipt,
  DomainEventRecord,
  OutboxMutationGroup,
  SyncQueueReceipt,
} from './contracts';
import type {
  ImportApplication,
  ImportApplicationDependencies,
  ImportDestination,
  ImportErrorCode,
  ImportJournal,
  ImportResult,
  ImportTransaction,
} from './import-contracts';
import {
  buildImportPlan,
  importDocumentLinks,
  validateImportGraph,
  type ImportPlan,
} from './import-plan';
import { createSerialQueue, serializeMethods, type SerialQueue } from './planning-kit';

class ImportFailure extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(code);
  }
}

/** Application-owned preview, durable recovery preparation, and one rollback-safe import command. */
export function createImportApplication(
  dependencies: ImportApplicationDependencies,
  options: { readonly queue?: SerialQueue } = {},
): ImportApplication {
  const { store, decoder, bundles, clock, ids } = dependencies;
  const encodeDestination = (
    destination: ImportDestination,
    bundleId: UUID,
  ): Promise<EncodedBundle> =>
    bundles.encode({
      snapshot: destination.snapshot,
      supplement: destination.supplement,
      bundleId,
      exportedAt: clock.now(),
      appVersion: dependencies.appVersion,
      sourceMode: destination.accountLinked ? 'account' : 'local',
      syncWasPending: destination.syncWasPending,
    });
  const destinationDigest = async (
    destination: ImportDestination,
    bundleId: UUID,
  ): Promise<string> => (await encodeDestination(destination, bundleId)).manifest.dataSha256;
  const outcome = async <T>(work: () => Promise<T>): Promise<ImportResult<T>> => {
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      return { ok: false, code: error instanceof ImportFailure ? error.code : 'storage_failed' };
    }
  };

  const preview: ImportApplication['preview'] = async (text, options = {}) => {
    const decoded = await decoder.decode(text);
    if (!decoded.ok) return decoded;
    return outcome(() =>
      store.runInTransaction(async (transaction) => {
        const destination = await transaction.destination();
        const previous = await transaction.journal();
        const previewId = previous?.text === text ? previous.id : ids.next();
        const decisions = options.decisions ?? [];
        const mode = options.mode ?? 'merge';
        const plan = buildImportPlan(
          decoded.value,
          destination,
          decisions,
          mode,
          previous?.text === text ? previous.duplicatedIds : {},
          () => ids.next(),
        );
        const journal: ImportJournal = {
          id: previewId,
          ownerId: destination.snapshot.ownerId,
          text,
          mode,
          decisions,
          duplicatedIds: plan.remap,
          destinationDigest: await destinationDigest(destination, previewId),
          createdAt: clock.now(),
        };
        await transaction.saveJournal(journal);
        return { ...plan.preview, previewId };
      }),
    );
  };

  const readPlan = async (
    transaction: ImportTransaction,
    journal: ImportJournal,
    destination: ImportDestination,
  ): Promise<ImportPlan> => {
    if (
      destination.snapshot.ownerId !== journal.ownerId ||
      (await destinationDigest(destination, journal.id)) !== journal.destinationDigest
    )
      throw new ImportFailure('preview_stale');
    const decoded = await decoder.decode(journal.text);
    if (!decoded.ok) throw new ImportFailure(decoded.code);
    const plan = buildImportPlan(
      decoded.value,
      destination,
      journal.decisions,
      journal.mode,
      journal.duplicatedIds,
      () => ids.next(),
    );
    if (!plan.preview.canApply)
      throw new ImportFailure(
        plan.preview.conflicts.length > 0 ? 'conflicts_unresolved' : 'invalid_graph',
      );
    return plan;
  };

  const apply: ImportApplication['apply'] = async (previewId, confirmation) => {
    const prepared = await outcome(() =>
      store.runInTransaction(async (transaction) => {
        const destination = await transaction.destination();
        const receipt = await transaction.receipts.find(destination.snapshot.ownerId, previewId);
        if (receipt !== null) return { receipt };
        const journal = await transaction.journal();
        if (journal === null || journal.id !== previewId)
          throw new ImportFailure('preview_missing');
        const plan = await readPlan(transaction, journal, destination);
        if (journal.mode === 'replace' && confirmation !== 'REPLACE MY PLAN')
          throw new ImportFailure('confirmation_required');
        if (plan.preview.backupRequired) {
          const backup = await encodeDestination(destination, ids.next());
          const verified = await bundles.verify(backup.text);
          if (
            !verified.ok ||
            verified.bundleId !== backup.bundleId ||
            verified.manifest.dataSha256 !== backup.manifest.dataSha256
          )
            throw new ImportFailure('backup_failed');
          await transaction.saveBackup(backup, clock.now());
          const durable = await transaction.backup();
          if (
            durable === null ||
            durable.backupId !== backup.bundleId ||
            !(await bundles.verify(durable.text)).ok
          )
            throw new ImportFailure('backup_failed');
        }
        return { receipt: null };
      }),
    );
    if (!prepared.ok) return prepared;
    if (prepared.value.receipt !== null) return { ok: true, value: prepared.value.receipt };

    let committedRefs: readonly EntityRef[] = [];
    const result = await outcome(() =>
      store.runInTransaction(async (transaction) => {
        const destination = await transaction.destination();
        const existingReceipt = await transaction.receipts.find(
          destination.snapshot.ownerId,
          previewId,
        );
        if (existingReceipt !== null) return existingReceipt;
        const journal = await transaction.journal();
        if (journal === null || journal.id !== previewId)
          throw new ImportFailure('preview_missing');
        const plan = await readPlan(transaction, journal, destination);
        const now = clock.now();
        const context = {
          ownerId: destination.snapshot.ownerId,
          actor: 'import' as const,
          commandId: previewId,
          now,
        };
        const mutations: CanonicalMutation[] = [];
        const applied: CommandReceipt['canonical'][number][] = [];
        const events: DomainEventRecord[] = [];
        const addEvent = (ref: EntityRef, operation: CanonicalMutation['operation']): void => {
          events.push({
            eventId: ids.next(),
            ownerId: context.ownerId,
            event: {
              aggregate: ref,
              actor: 'import',
              commandId: previewId,
              eventType: 'import.record_applied',
              version: 1,
              occurredAt: now,
              payload: { operation },
            },
          });
        };
        await transaction.prepareReplacementDeletes(
          plan.deleted.map(({ type, id }) => ({ type, id })),
          now,
        );
        // Dependents leave first; parents arrive first. Deferred keys handle a legal cyclic reference.
        for (const row of orderRecords(plan.deleted).reverse()) {
          const ref = createEntityRef(row.type, row.id, context.ownerId);
          const before = await transaction.records.read(ref);
          if (before === null) throw new ImportFailure('preview_stale');
          const mutation: CanonicalMutation = {
            operation: 'delete',
            ref,
            expectedRevision: before.localRevision,
            baseServerRevision: before.serverRevision,
            baseSnapshotHash: before.baseSnapshotHash,
            tombstone: createDeletionTombstone(ref, before.localRevision + 1, now),
          };
          const change = await transaction.records.apply(mutation, context);
          mutations.push(mutation);
          applied.push({ ref, localRevision: change.localRevision });
          addEvent(ref, 'delete');
        }
        const restoredBases = new Map<string, number>();
        for (const row of plan.restored)
          restoredBases.set(
            `${row.type}:${row.id}`,
            await transaction.clearDeletion(row.type, row.id),
          );
        for (const row of orderRecords(plan.accepted)) {
          const ref = createEntityRef(row.type, row.id, context.ownerId);
          const before = await transaction.records.read(ref);
          const mutation: CanonicalMutation =
            before === null
              ? {
                  operation: 'create',
                  ref,
                  expectedRevision: null,
                  baseServerRevision: 0,
                  baseSnapshotHash: null,
                  document: row.document,
                }
              : {
                  operation: 'update',
                  ref,
                  expectedRevision: before.localRevision,
                  baseServerRevision: before.serverRevision,
                  baseSnapshotHash: before.baseSnapshotHash,
                  document: row.document,
                };
          if (row.type === 'profile' && before === null) {
            await transaction.createProfile(row, plan.supplement, now);
            applied.push({ ref, localRevision: 1 });
          } else {
            const change = await transaction.records.apply(mutation, context);
            applied.push({ ref, localRevision: change.localRevision });
          }
          const restoredBase = restoredBases.get(`${row.type}:${row.id}`) ?? 0;
          if (restoredBase > 0) {
            await transaction.setRestoredBase(row.type, row.id, restoredBase);
            mutations.push({
              operation: 'update',
              ref,
              expectedRevision: 1,
              baseServerRevision: restoredBase,
              baseSnapshotHash: null,
              document: row.document,
            });
          } else mutations.push(mutation);
          addEvent(ref, mutation.operation);
        }
        await transaction.events.append(events);
        let queued: OutboxMutationGroup | null = null;
        const syncMutations = mutations.filter(
          (mutation) => mutation.operation !== 'delete' || mutation.baseServerRevision > 0,
        );
        if (destination.accountLinked && syncMutations.length > 0) {
          const mutationGroupId = ids.next();
          queued = {
            mutationGroupId,
            ownerId: context.ownerId,
            commandId: previewId,
            actor: 'import',
            createdAt: now,
            operations: syncMutations.map((mutation, sequence) => ({
              operationId: ids.next(),
              mutationGroupId,
              sequence,
              state: 'pending',
              attemptCount: 0,
              nextAttemptAt: now,
              mutation,
            })),
          };
          await transaction.outbox.append(queued);
        }
        await transaction.applySupplement(plan.supplement, journal.mode, plan.remap, now);
        await transaction.validateCommittedGraph();
        const receipt: CommandReceipt = {
          commandId: previewId,
          ownerId: context.ownerId,
          actor: 'import',
          acceptedAt: now,
          canonical: applied,
          eventIds: events.map(({ eventId }) => eventId),
          undo: { available: false },
          sync:
            queued === null
              ? { queued: false }
              : {
                  queued: true,
                  mutationGroupId: queued.mutationGroupId,
                  operationIds: queued.operations.map(({ operationId }) => operationId),
                },
        };
        await transaction.receipts.append(receipt);
        await transaction.discardJournal();
        committedRefs = applied.map(({ ref }) => ref);
        return receipt;
      }),
    );
    if (result.ok && committedRefs.length > 0) {
      try {
        await dependencies.projections?.notifyCommitted({
          commandId: result.value.commandId,
          ownerId: result.value.ownerId,
          committedAt: result.value.acceptedAt,
          touched: committedRefs,
        });
      } catch {
        /* Read models are rebuildable after the canonical transaction committed. */
      }
    }
    return result;
  };

  const application: ImportApplication = {
    preview,
    apply,
    pending: () => store.readJournal(),
    resume: async () => {
      const pending = await outcome(() => store.readJournal());
      if (!pending.ok) return pending;
      const journal = pending.value;
      return journal === null
        ? { ok: false, code: 'preview_missing' }
        : preview(journal.text, { mode: journal.mode, decisions: journal.decisions });
    },
    discard: () =>
      outcome(() => store.runInTransaction((transaction) => transaction.discardJournal())),
    recoveryBackup: () => store.runInTransaction((transaction) => transaction.backup()),
    recoveryConflicts: () =>
      store.runInTransaction((transaction) => transaction.recoveryConflicts()),
    resolveRecovery: async (conflictId, choice) => {
      const prepared = await outcome(() =>
        store.runInTransaction(async (transaction) => {
          const destination = await transaction.destination();
          if (destination.unconfirmedSync) throw new ImportFailure('preview_stale');
          const conflict = (await transaction.recoveryConflicts()).find(
            (row) => row.conflictId === conflictId,
          );
          if (conflict === undefined) throw new ImportFailure('preview_missing');
          const backup = await encodeDestination(destination, ids.next());
          if (!(await bundles.verify(backup.text)).ok) throw new ImportFailure('backup_failed');
          await transaction.saveBackup(backup, clock.now());
        }),
      );
      if (!prepared.ok) return prepared;
      const resolution = await outcome(() =>
        store.runInTransaction(async (transaction) => {
          const destination = await transaction.destination();
          if (destination.unconfirmedSync) throw new ImportFailure('preview_stale');
          const conflict = (await transaction.recoveryConflicts()).find(
            (row) => row.conflictId === conflictId,
          );
          if (conflict === undefined) throw new ImportFailure('preview_missing');
          const ref = createEntityRef(
            conflict.entityType,
            conflict.entityId,
            destination.snapshot.ownerId,
          );
          const before = await transaction.records.read(ref);
          const side = choice === 'use_local' ? conflict.local : conflict.remote;
          const now = clock.now();
          const commandId = ids.next();
          const context = { ownerId: ref.ownerId, actor: 'import' as const, commandId, now };
          await transaction.closeRecoveryConflict(conflictId, now);
          const changes: CommandReceipt['canonical'][number][] = [];
          const events: DomainEventRecord[] = [];
          let mutation: CanonicalMutation | null = null;
          let rewritten: SyncQueueReceipt = { queued: false };
          if (choice !== 'keep_current') {
            const graph = destination.snapshot.records.filter(
              (row) => row.type !== ref.type || row.id !== ref.id,
            );
            if (!side.deleted && side.document !== null)
              graph.push({
                type: ref.type,
                id: ref.id,
                localRevision: before?.localRevision ?? 1,
                document: side.document,
              });
            if (validateImportGraph(graph).length > 0) throw new ImportFailure('invalid_graph');
            if (!side.deleted && side.document !== null && destination.accountLinked)
              rewritten = await transaction.rewriteRecoveryOperations(
                ref.type,
                ref.id,
                side.document,
                now,
              );
            if (!rewritten.queued)
              await transaction.prepareReplacementDeletes([{ type: ref.type, id: ref.id }], now);
            if (side.deleted && before !== null)
              mutation = {
                operation: 'delete',
                ref,
                expectedRevision: before.localRevision,
                baseServerRevision: before.serverRevision,
                baseSnapshotHash: before.baseSnapshotHash,
                tombstone: createDeletionTombstone(ref, before.localRevision + 1, now),
              };
            else if (!side.deleted && side.document !== null) {
              const restoredBase =
                before === null ? await transaction.clearDeletion(ref.type, ref.id) : 0;
              mutation =
                before === null
                  ? {
                      operation: 'create',
                      ref,
                      expectedRevision: null,
                      baseServerRevision: 0,
                      baseSnapshotHash: null,
                      document: side.document,
                    }
                  : {
                      operation: 'update',
                      ref,
                      expectedRevision: before.localRevision,
                      baseServerRevision: before.serverRevision,
                      baseSnapshotHash: before.baseSnapshotHash,
                      document: side.document,
                    };
              const change = await transaction.records.apply(mutation, context);
              changes.push({ ref, localRevision: change.localRevision });
              if (restoredBase > 0) {
                await transaction.setRestoredBase(ref.type, ref.id, restoredBase);
                mutation = {
                  operation: 'update',
                  ref,
                  expectedRevision: 1,
                  baseServerRevision: restoredBase,
                  baseSnapshotHash: null,
                  document: side.document,
                };
              } else if (before !== null && before.serverRevision === 0)
                mutation = {
                  operation: 'create',
                  ref,
                  expectedRevision: null,
                  baseServerRevision: 0,
                  baseSnapshotHash: null,
                  document: side.document,
                };
            }
            if (mutation?.operation === 'delete') {
              const change = await transaction.records.apply(mutation, context);
              changes.push({ ref, localRevision: change.localRevision });
            }
          }
          events.push({
            eventId: ids.next(),
            ownerId: ref.ownerId,
            event: {
              aggregate: ref,
              actor: 'import',
              commandId,
              eventType: 'import.recovery_resolved',
              version: 1,
              occurredAt: now,
              payload: { choice },
            },
          });
          await transaction.events.append(events);
          let queued: OutboxMutationGroup | null = null;
          if (
            destination.accountLinked &&
            !rewritten.queued &&
            mutation !== null &&
            (mutation.operation !== 'delete' || mutation.baseServerRevision > 0)
          ) {
            const mutationGroupId = ids.next();
            queued = {
              mutationGroupId,
              ownerId: ref.ownerId,
              commandId,
              actor: 'import',
              createdAt: now,
              operations: [
                {
                  operationId: ids.next(),
                  mutationGroupId,
                  sequence: 0,
                  state: 'pending',
                  attemptCount: 0,
                  nextAttemptAt: now,
                  mutation,
                },
              ],
            };
            await transaction.outbox.append(queued);
          }
          await transaction.validateCommittedGraph();
          const receipt: CommandReceipt = {
            commandId,
            ownerId: ref.ownerId,
            actor: 'import',
            acceptedAt: now,
            canonical: changes,
            eventIds: events.map((event) => event.eventId),
            undo: { available: false },
            sync: rewritten.queued
              ? rewritten
              : queued === null
                ? { queued: false }
                : {
                    queued: true,
                    mutationGroupId: queued.mutationGroupId,
                    operationIds: queued.operations.map((operation) => operation.operationId),
                  },
          };
          await transaction.receipts.append(receipt);
          return receipt;
        }),
      );
      if (resolution.ok) {
        try {
          await dependencies.projections?.notifyCommitted({
            commandId: resolution.value.commandId,
            ownerId: resolution.value.ownerId,
            committedAt: resolution.value.acceptedAt,
            touched: resolution.value.canonical.map(({ ref }) => ref),
          });
        } catch {
          /* Canonical writes have committed. */
        }
      }
      return resolution;
    },
  };
  return serializeMethods(application, options.queue ?? createSerialQueue());
}

/** Parent-first ordering uses typed references, so titles that resemble UUIDs are never remapped. */
function orderRecords(
  records: readonly ImportPlan['accepted'][number][],
): ImportPlan['accepted'][number][] {
  const byKey = new Map(records.map((row) => [`${row.type}:${row.id}`, row]));
  const ordered: ImportPlan['accepted'][number][] = [];
  const visited = new Set<string>();
  for (const row of records) {
    const pending: { readonly row: ImportPlan['accepted'][number]; readonly finish: boolean }[] = [
      { row, finish: false },
    ];
    while (pending.length > 0) {
      const entry = pending.pop();
      if (entry === undefined) continue;
      const rowKey = `${entry.row.type}:${entry.row.id}`;
      if (entry.finish) {
        ordered.push(entry.row);
        continue;
      }
      if (visited.has(rowKey)) continue;
      visited.add(rowKey);
      pending.push({ row: entry.row, finish: true });
      for (const link of [...importDocumentLinks(entry.row.document)].reverse()) {
        const parent = byKey.get(`${link.type}:${link.id}`);
        if (parent !== undefined) pending.push({ row: parent, finish: false });
      }
    }
  }
  return ordered;
}
