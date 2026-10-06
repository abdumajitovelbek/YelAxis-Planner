import type { EntityType, Instant, OwnerId, UUID } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import type { CanonicalSnapshotRecord } from './account-contracts';
import {
  documentBytes,
  initialUploadLimits,
  initialUploadOrder,
  orderForInitialUpload,
  planInitialUpload,
} from './account-upload-plan';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const commandId = '20000000-0000-4000-8000-000000000001' as UUID;
const now = '2026-10-01T09:00:00.000Z' as Instant;

function idSequence(prefix = '30000000') {
  let counter = 0;
  return {
    next: () => {
      counter += 1;
      return `${prefix}-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as UUID;
    },
  };
}

function record(
  type: EntityType,
  index: number,
  document: Readonly<Record<string, unknown>> = { title: `Record ${String(index)}` },
): CanonicalSnapshotRecord {
  return {
    type,
    id: `40000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}` as UUID,
    localRevision: 1,
    document,
  };
}

describe('initial upload plan', () => {
  it('orders every entity type exactly once, parents before the records that name them', () => {
    const allTypes: readonly EntityType[] = [
      'profile',
      'axis',
      'outcome',
      'milestone',
      'project',
      'action',
      'note',
      'commitment',
      'time_block',
      'routine',
      'routine_occurrence',
      'routine_action_defaults',
      'template',
      'review',
      'review_item',
      'reminder',
      'context',
      'constraint',
      'planning_placement',
      'focus_selection',
      'theme',
      'direction',
      'project_secondary_outcome',
      'milestone_project',
      'milestone_action',
    ];
    expect([...initialUploadOrder].sort()).toEqual([...allTypes].sort());
    const before = (parent: EntityType, child: EntityType) =>
      expect(initialUploadOrder.indexOf(parent)).toBeLessThan(initialUploadOrder.indexOf(child));
    before('context', 'constraint');
    before('axis', 'outcome');
    before('outcome', 'project');
    before('outcome', 'milestone');
    before('project', 'note');
    before('project', 'action');
    before('note', 'action');
    before('routine', 'routine_occurrence');
    before('routine', 'routine_action_defaults');
    before('routine_occurrence', 'time_block');
    before('commitment', 'time_block');
    before('action', 'planning_placement');
    before('profile', 'focus_selection');
    before('milestone', 'milestone_action');
    before('review', 'review_item');
    before('time_block', 'reminder');
    before('review', 'reminder');
  });

  it('queues ordinary create groups with base revision 0, no hash, and one command id', () => {
    const records = [record('action', 2), record('profile', 1), record('axis', 3)];
    const groups = planInitialUpload({
      snapshot: { ownerId, records },
      commandId,
      now,
      ids: idSequence(),
    });
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group).toMatchObject({ ownerId, commandId, actor: 'user', createdAt: now });
    expect(group?.operations.map(({ mutation }) => mutation.ref.type)).toEqual([
      'profile',
      'axis',
      'action',
    ]);
    group?.operations.forEach((operation, index) => {
      expect(operation).toMatchObject({
        mutationGroupId: group.mutationGroupId,
        sequence: index,
        state: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        mutation: {
          operation: 'create',
          expectedRevision: null,
          baseServerRevision: 0,
          baseSnapshotHash: null,
        },
      });
      expect(operation.mutation.ref.ownerId).toBe(ownerId);
    });
    const operationIds = new Set(group?.operations.map(({ operationId }) => operationId));
    expect(operationIds.size).toBe(3);
  });

  it('keeps at most 500 operations in a group and every record exactly once', () => {
    const records = Array.from({ length: 1_201 }, (_, index) => record('action', index + 1));
    const groups = planInitialUpload({
      snapshot: { ownerId, records },
      commandId,
      now,
      ids: idSequence(),
    });
    expect(groups.map(({ operations }) => operations.length)).toEqual([500, 500, 201]);
    const uploaded = groups.flatMap(({ operations }) => operations.map((o) => o.mutation.ref.id));
    expect(new Set(uploaded).size).toBe(1_201);
    expect(uploaded).toEqual([...uploaded].sort());
  });

  it('bounds the documents of a group by size and sends an oversized document alone', () => {
    const large = { note: 'x'.repeat(40 * 1024) };
    const oversized = { note: 'y'.repeat(initialUploadLimits.documentBytes + 1) };
    expect(documentBytes(oversized)).toBeGreaterThan(initialUploadLimits.documentBytes);
    const records = [
      ...Array.from({ length: 50 }, (_, index) => record('note', index + 1, large)),
      record('note', 100, oversized),
      record('note', 101),
    ];
    const groups = planInitialUpload({
      snapshot: { ownerId, records },
      commandId,
      now,
      ids: idSequence(),
    });
    for (const group of groups) {
      const bytes = group.operations.reduce(
        (sum, operation) =>
          sum +
          documentBytes(
            operation.mutation.operation === 'delete' ? {} : operation.mutation.document,
          ),
        0,
      );
      expect(group.operations.length === 1 || bytes <= initialUploadLimits.groupDocumentBytes).toBe(
        true,
      );
    }
    const alone = groups.find(({ operations }) =>
      operations.some(({ mutation }) => mutation.ref.id === record('note', 100).id),
    );
    expect(alone?.operations).toHaveLength(1);
    expect(groups.flatMap(({ operations }) => operations)).toHaveLength(52);
  });

  it('places a superseding Time Block before the canceled block that names it', () => {
    const later = record('time_block', 1, { state: 'canceled', supersededById: idOf(3) });
    const middle = record('time_block', 3, { state: 'canceled', supersededById: idOf(2) });
    const current = record('time_block', 2, { state: 'planned' });
    const ordered = orderForInitialUpload([
      record('reminder', 9),
      later,
      middle,
      current,
      record('action', 7),
    ]);
    expect(ordered.map(({ type, id }) => `${type}:${id.slice(-1)}`)).toEqual([
      'action:7',
      'time_block:2',
      'time_block:3',
      'time_block:1',
      'reminder:9',
    ]);
  });

  it('returns no group for an empty snapshot', () => {
    expect(
      planInitialUpload({ snapshot: { ownerId, records: [] }, commandId, now, ids: idSequence() }),
    ).toEqual([]);
  });
});

function idOf(index: number): string {
  return `40000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}
