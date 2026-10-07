import type { EntityType, IdProvider, Instant, OwnerId, UUID } from '@yelaxis/domain';

import type { CanonicalSnapshot, CanonicalSnapshotRecord } from './account-contracts';
import type { OutboxMutationGroup } from './contracts';

/**
 * The bounds of one pushed group: at most 500 operations, 64 KB per document, and
 * 2 MB per request. Documents of one group stay under 1.5 MB, which leaves room for the request
 * envelope. These mirror the sync protocol limits; a web test keeps them equal.
 */
export const initialUploadLimits = Object.freeze({
  operationsPerGroup: 500,
  documentBytes: 64 * 1024,
  groupDocumentBytes: 1_536 * 1024,
});

/**
 * Dependency order of the initial upload: every record follows the records it names, so each group
 * and each operation can be checked against references that already exist on the server.
 */
export const initialUploadOrder: readonly EntityType[] = Object.freeze([
  'profile',
  'context',
  'constraint',
  'axis',
  'outcome',
  'milestone',
  'project',
  'note',
  'action',
  'commitment',
  'template',
  'routine',
  'routine_action_defaults',
  'routine_occurrence',
  'time_block',
  'planning_placement',
  'focus_selection',
  'theme',
  'direction',
  'project_secondary_outcome',
  'milestone_project',
  'milestone_action',
  'review',
  'review_item',
  'reminder',
] satisfies readonly EntityType[]);

type MissingUploadType = Exclude<EntityType, (typeof initialUploadOrder)[number]>;
const uploadOrderParity: [MissingUploadType] extends [never] ? true : never = true;
void uploadOrderParity;

const encoder = new TextEncoder();

/** UTF-8 size of a document as it travels. */
export function documentBytes(document: Readonly<Record<string, unknown>>): number {
  return encoder.encode(JSON.stringify(document)).byteLength;
}

/**
 * Orders records by `initialUploadOrder`, then by id. A canceled Time Block names the block that
 * superseded it, so within Time Blocks a superseding block always comes first.
 */
export function orderForInitialUpload(
  records: readonly CanonicalSnapshotRecord[],
): CanonicalSnapshotRecord[] {
  const rank = new Map(initialUploadOrder.map((type, index) => [type, index]));
  const sorted = [...records].sort(
    (left, right) =>
      (rank.get(left.type) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(right.type) ?? Number.MAX_SAFE_INTEGER) || compareIds(left.id, right.id),
  );
  const blocks = sorted.filter(({ type }) => type === 'time_block');
  if (blocks.length < 2) return sorted;

  const byId = new Map(blocks.map((record) => [record.id, record]));
  const ordered: CanonicalSnapshotRecord[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (record: CanonicalSnapshotRecord): void => {
    if (placed.has(record.id) || visiting.has(record.id)) return;
    visiting.add(record.id);
    const superseding = record.document['supersededById'];
    const next = typeof superseding === 'string' ? byId.get(superseding as UUID) : undefined;
    if (next !== undefined) place(next);
    visiting.delete(record.id);
    placed.add(record.id);
    ordered.push(record);
  };
  for (const record of blocks) place(record);

  const firstBlock = sorted.findIndex(({ type }) => type === 'time_block');
  return [...sorted.slice(0, firstBlock), ...ordered, ...sorted.slice(firstBlock + blocks.length)];
}

export interface InitialUploadInput {
  readonly snapshot: CanonicalSnapshot;
  /** Shared by every group of one link, so its groups can be found again. */
  readonly commandId: UUID;
  readonly now: Instant;
  readonly ids: IdProvider;
}

/**
 * The initial upload as ordinary outbox groups of `create` operations (base revision 0, no base
 * snapshot hash) in dependency order, each within the group bounds. A document over the per-document
 * limit travels alone, so the server's refusal of it cannot hold back any other record.
 */
export function planInitialUpload(input: InitialUploadInput): OutboxMutationGroup[] {
  const groups: OutboxMutationGroup[] = [];
  let current: CanonicalSnapshotRecord[] = [];
  let currentBytes = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    groups.push(createGroup(input, input.snapshot.ownerId, current));
    current = [];
    currentBytes = 0;
  };

  for (const record of orderForInitialUpload(input.snapshot.records)) {
    const bytes = documentBytes(record.document);
    if (bytes > initialUploadLimits.documentBytes) {
      flush();
      current = [record];
      flush();
      continue;
    }
    if (
      current.length === initialUploadLimits.operationsPerGroup ||
      currentBytes + bytes > initialUploadLimits.groupDocumentBytes
    ) {
      flush();
    }
    current.push(record);
    currentBytes += bytes;
  }
  flush();
  return groups;
}

function createGroup(
  input: InitialUploadInput,
  ownerId: OwnerId,
  records: readonly CanonicalSnapshotRecord[],
): OutboxMutationGroup {
  const mutationGroupId = input.ids.next();
  return {
    mutationGroupId,
    ownerId,
    commandId: input.commandId,
    actor: 'user',
    createdAt: input.now,
    operations: records.map((record, sequence) => ({
      operationId: input.ids.next(),
      mutationGroupId,
      sequence,
      state: 'pending',
      attemptCount: 0,
      nextAttemptAt: input.now,
      mutation: {
        ref: { type: record.type, id: record.id, ownerId },
        operation: 'create',
        expectedRevision: null,
        baseServerRevision: 0,
        baseSnapshotHash: null,
        document: record.document,
      },
    })),
  };
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
