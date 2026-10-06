/**
 * The planning Week-commitment rules (placement contract "Ordering and selections"), shared by
 * `addWeekCommitment`, `removeWeekCommitment`, and a weekly review's Finish so every commitment
 * change follows one path.
 *
 * A Week commitment targets an Action, a Project, or a Milestone; it is unique per target and exact
 * Week, keeps its order, and never changes its target. A new commitment's target must exist and must
 * not be archived. Removing one archives the selection. Everyday planning may hold more than three
 * with a small-set warning; a weekly review chooses at most three.
 */
import {
  compareOrder,
  createEntityRef,
  entityRefKey,
  ok,
  type CommandContext,
  type DomainResult,
  type EntityRef,
  type Instant,
  type OwnerId,
  type UUID,
  type WeekPeriod,
} from '@yelaxis/domain';

import type { CanonicalMutation, CanonicalRecordState, ExpectedRevision } from './contracts';
import type {
  FocusSelectionDocument,
  PlanningQueryPort,
  WeekSelectionRow,
} from './planning-contracts';
import { createMutation, updateFrom, type CreatedRecord } from './planning-kit';
import { changed, invalid, isArchivedDocument } from './planning-scheduling-support';
import type { PlanningRecordReader } from './ports';

/** Per-record event types of Week-commitment changes. Payloads carry only `{ operation }`. */
export const weekCommitmentEventTypes = Object.freeze({
  added: 'planning.week_commitment_added',
  removed: 'planning.week_commitment_removed',
  reordered: 'planning.week_commitment_reordered',
});

export type WeekCommitmentKind = 'action' | 'project' | 'milestone';

export const weekCommitmentKinds: readonly WeekCommitmentKind[] = [
  'action',
  'project',
  'milestone',
];

/** What one Week commitment is about. */
export interface WeekCommitmentTarget {
  readonly kind: WeekCommitmentKind;
  readonly id: UUID;
}

/** Stable identity of a commitment target within one Week. */
export const weekCommitmentKey = (target: WeekCommitmentTarget): string =>
  `${target.kind}:${target.id}`;

export function weekCommitmentTargetDocument(
  target: WeekCommitmentTarget,
): FocusSelectionDocument['target'] {
  switch (target.kind) {
    case 'action':
      return { kind: 'action', actionId: target.id };
    case 'project':
      return { kind: 'project', projectId: target.id };
    case 'milestone':
      return { kind: 'milestone', milestoneId: target.id };
  }
}

/** The target of a stored Week commitment, or null when the document is not one. */
export function weekCommitmentTargetOf(
  document: FocusSelectionDocument,
): WeekCommitmentTarget | null {
  if (document.kind !== 'week_commitment') return null;
  switch (document.target.kind) {
    case 'action':
      return { kind: 'action', id: document.target.actionId };
    case 'project':
      return { kind: 'project', id: document.target.projectId };
    case 'milestone':
      return { kind: 'milestone', id: document.target.milestoneId };
    case 'routine_occurrence':
      return null;
  }
}

export const weekCommitmentRef = (
  ownerId: OwnerId,
  target: WeekCommitmentTarget,
): EntityRef<WeekCommitmentKind> => createEntityRef(target.kind, target.id, ownerId);

/** A new Week commitment of this profile and exact Week. */
export function weekCommitmentDocument(
  profileId: UUID,
  week: WeekPeriod,
  target: WeekCommitmentTarget,
  orderKey: string,
): FocusSelectionDocument {
  return {
    kind: 'week_commitment',
    profileId,
    target: weekCommitmentTargetDocument(target),
    periodStart: week.start,
    periodEnd: week.end,
    weekStart: week.weekStart,
    orderKey,
  };
}

const sequenceKeyPattern = /^\d{15}$/u;

/** The key after a Week's commitments: one past the highest 15-digit key (planning). */
export function appendWeekCommitmentKey(orderKeys: readonly string[]): string {
  const highest = orderKeys.reduce(
    (max, key) => Math.max(max, sequenceKeyPattern.test(key) ? Number(key) : 0),
    0,
  );
  return String(highest + 1).padStart(15, '0');
}

/** The key of position `index` (0-based) when a chosen list is written in order. */
const positionKey = (index: number): string => String(index + 1).padStart(15, '0');

/** A new commitment's target must still exist and must not be archived (inside the command). */
export async function checkWeekCommitmentTarget(
  records: PlanningRecordReader,
  ref: EntityRef,
): Promise<DomainResult<true>> {
  const current = await records.read(ref);
  if (current === null) return changed('target_missing');
  if (isArchivedDocument(current.document))
    return invalid('archived_target', 'Restore this item before selecting it.');
  return ok(true);
}

/** Remove one commitment: it must still be an active Week commitment, and it is archived. */
export function removeWeekCommitmentMutation(
  record: CanonicalRecordState,
  now: Instant,
): DomainResult<CanonicalMutation> {
  const document = record.document as FocusSelectionDocument;
  if (document.kind !== 'week_commitment') return invalid('not_week_commitment');
  if (document.archivedAt !== undefined)
    return invalid('already_removed', 'This commitment was already removed.');
  return ok(updateFrom(record, { ...document, archivedAt: now }));
}

/* ───────────────────────── Pre-reads ───────────────────────── */

/** A Week's active commitments, read before a command opens (outside the transaction). */
export interface WeekCommitmentRecords {
  /** Rows of exactly this Week, in (order key, id) order. */
  readonly rows: readonly WeekSelectionRow[];
  /** Their canonical records, for `planWeekCommitmentMutations` (`existing`). */
  readonly records: readonly CanonicalRecordState[];
  /** Their current revisions, for a command that must keep them as they were read. */
  readonly expected: readonly ExpectedRevision[];
}

/** A Week's active commitments as rows: exactly this Week, in (order key, id) order. */
export async function weekCommitmentRows(
  queries: Pick<PlanningQueryPort, 'listWeekSelections'>,
  ownerId: OwnerId,
  week: WeekPeriod,
): Promise<WeekSelectionRow[]> {
  return (await queries.listWeekSelections(ownerId, { start: week.start, end: week.end }))
    .filter((row) => row.period.start === week.start && row.period.end === week.end)
    .sort(compareOrder);
}

export async function readWeekCommitments(
  queries: Pick<PlanningQueryPort, 'listWeekSelections' | 'readRecord'>,
  ownerId: OwnerId,
  week: WeekPeriod,
): Promise<WeekCommitmentRecords> {
  const rows = await weekCommitmentRows(queries, ownerId, week);
  const records: CanonicalRecordState[] = [];
  for (const row of rows) {
    const record = await queries.readRecord(
      ownerId,
      createEntityRef('focus_selection', row.id, ownerId),
    );
    if (record !== null) records.push(record);
  }
  return {
    rows,
    records,
    expected: records.map((record) => ({ ref: record.ref, revision: record.localRevision })),
  };
}

/* ───────────────────────── Planning ───────────────────────── */

export interface WeekCommitmentRequest {
  readonly ownerId: OwnerId;
  readonly profileId: UUID;
  /** The exact Week. */
  readonly week: WeekPeriod;
  /**
   * The Week's active commitments read before the command. Rows that change are read again inside
   * it; a caller that relies on the others staying as read expects their revisions.
   */
  readonly existing: readonly CanonicalRecordState[];
  /** The complete chosen list in order, each target once. */
  readonly desired: readonly WeekCommitmentTarget[];
  /**
   * `addWeekCommitment`, which expects no existing revision: when targets are only appended, kept
   * rows keep their keys and each new one takes the next 15-digit key exactly as planning always did,
   * even when an older key outside that space (onboarding's `onboarding-01`) still sorts after it.
   */
  readonly keepKeys?: boolean;
}

export interface WeekCommitmentPlan {
  /** Archives, then order-key updates, then new commitments. */
  readonly mutations: readonly CanonicalMutation[];
  /** New commitments, for grouped undo. */
  readonly created: readonly CreatedRecord[];
  readonly eventTypeFor: (mutation: CanonicalMutation) => string | undefined;
}

interface CurrentCommitment {
  readonly record: CanonicalRecordState;
  readonly document: FocusSelectionDocument;
  readonly key: string;
}

/**
 * Plan a Week's commitments as the person chose them: `desired` is the complete ordered list.
 * Commitments that are no longer chosen are archived, kept ones keep their row, and new ones are
 * created after checking their target. Choosing the same list again changes nothing. When new
 * targets are only appended, kept rows keep their keys and each new one takes the next key (as
 * `addWeekCommitment` always did) if that keeps the chosen order; any other change writes the
 * chosen list's keys in order, which also normalizes an older key such as `onboarding-01`.
 */
export async function planWeekCommitmentMutations(
  records: PlanningRecordReader,
  request: WeekCommitmentRequest,
  nextId: () => UUID,
  context: CommandContext,
): Promise<DomainResult<WeekCommitmentPlan>> {
  const desiredKeys = request.desired.map(weekCommitmentKey);
  if (new Set(desiredKeys).size !== desiredKeys.length)
    return invalid('duplicate_commitment', 'Each item can be a commitment for a week once.');

  const current: CurrentCommitment[] = [];
  for (const record of request.existing) {
    const document = record.document as FocusSelectionDocument;
    const target = weekCommitmentTargetOf(document);
    if (target === null) return changed('commitments_changed');
    current.push({ record, document, key: weekCommitmentKey(target) });
  }
  current.sort((left, right) =>
    compareOrder(
      { id: left.record.ref.id, orderKey: left.document.orderKey },
      { id: right.record.ref.id, orderKey: right.document.orderKey },
    ),
  );

  const kept = new Map<string, CurrentCommitment>();
  const archived: CurrentCommitment[] = [];
  for (const row of current) {
    if (desiredKeys.includes(row.key) && !kept.has(row.key)) kept.set(row.key, row);
    else archived.push(row);
  }
  const keptInChosenOrder = desiredKeys.flatMap((key) => {
    const row = kept.get(key);
    return row === undefined ? [] : [row];
  });
  const keptInCurrentOrder = current.filter((row) => kept.get(row.key) === row);
  const sameOrder = keptInChosenOrder.every((row, index) => keptInCurrentOrder[index] === row);
  const appendedOnly = desiredKeys.slice(0, keptInChosenOrder.length).every((key) => kept.has(key));

  // Every target's order key after the change.
  const keys = new Map<string, string>();
  if (sameOrder && appendedOnly) {
    const used = keptInChosenOrder.map((row) => row.document.orderKey);
    for (const key of desiredKeys) {
      const row = kept.get(key);
      if (row !== undefined) keys.set(key, row.document.orderKey);
      else {
        const appended = appendWeekCommitmentKey(used);
        used.push(appended);
        keys.set(key, appended);
      }
    }
  }
  // Appended keys must keep the chosen order: a next 15-digit key sorts before an older key such as
  // `onboarding-01`. (Kept rows already follow it; equal keys sort by id.) Only `addWeekCommitment`
  // (`keepKeys`) appends regardless, as planning always did.
  const ordered = desiredKeys.map((key) => keys.get(key) ?? '');
  const keepsOrder = ordered.every(
    (key, index) => index === 0 || (ordered[index - 1] ?? '') <= key,
  );
  if (!(sameOrder && appendedOnly) || (!keepsOrder && request.keepKeys !== true)) {
    keys.clear();
    desiredKeys.forEach((key, index) => keys.set(key, positionKey(index)));
  }

  const mutations: CanonicalMutation[] = [];
  const created: CreatedRecord[] = [];
  const eventTypes = new Map<string, string>();
  const push = (mutation: CanonicalMutation, eventType: string): void => {
    mutations.push(mutation);
    eventTypes.set(entityRefKey(mutation.ref), eventType);
  };

  /** A row that changes is read again: it must still be this Week's active commitment. */
  const reread = async (row: CurrentCommitment): Promise<DomainResult<CanonicalRecordState>> => {
    const record = await records.read(row.record.ref);
    const document = record?.document as FocusSelectionDocument | undefined;
    if (
      record === null ||
      document === undefined ||
      document.kind !== 'week_commitment' ||
      document.archivedAt !== undefined ||
      document.profileId !== request.profileId ||
      document.periodStart !== request.week.start ||
      document.periodEnd !== request.week.end ||
      document.orderKey !== row.document.orderKey
    )
      return changed('commitments_changed');
    return ok(record);
  };

  for (const row of archived) {
    const record = await reread(row);
    if (!record.ok) return record;
    const mutation = removeWeekCommitmentMutation(record.value, context.now);
    if (!mutation.ok) return mutation;
    push(mutation.value, weekCommitmentEventTypes.removed);
  }
  for (const row of keptInChosenOrder) {
    const orderKey = keys.get(row.key);
    if (orderKey === undefined || orderKey === row.document.orderKey) continue;
    const record = await reread(row);
    if (!record.ok) return record;
    push(
      updateFrom(record.value, { ...(record.value.document as FocusSelectionDocument), orderKey }),
      weekCommitmentEventTypes.reordered,
    );
  }
  for (const [index, target] of request.desired.entries()) {
    const key = desiredKeys[index];
    if (key === undefined || kept.has(key)) continue;
    const available = await checkWeekCommitmentTarget(
      records,
      weekCommitmentRef(request.ownerId, target),
    );
    if (!available.ok) return available;
    const orderKey = keys.get(key);
    if (orderKey === undefined) return changed('commitments_changed');
    const ref = createEntityRef('focus_selection', nextId(), request.ownerId);
    push(
      createMutation(
        ref,
        weekCommitmentDocument(request.profileId, request.week, target, orderKey),
      ),
      weekCommitmentEventTypes.added,
    );
    created.push({ ref, kind: 'focus_selection' });
  }

  return ok({
    mutations,
    created,
    eventTypeFor: (mutation) => eventTypes.get(entityRefKey(mutation.ref)),
  });
}
