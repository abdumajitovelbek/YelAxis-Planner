/**
 * Review drafts: Save and Skip, and the review-record steps Finish shares.
 *
 * Each command is one `executeCommand` transaction. The input is checked completely before the plan
 * is read; the saved review and its items are read before the command and every expected revision
 * is listed; every check that depends on stored state runs inside the command, after the
 * command-id receipt lookup, so a repeated command id returns its receipt and a refused command
 * writes nothing. Save and Skip never change the plan: review items stay drafts until Finish
 * applies them.
 */
import {
  createEntityRef,
  endDayCarryDate,
  entityRefKey,
  isAlignedReviewPeriod,
  isReviewablePeriod,
  ok,
  planReviewFinish,
  planReviewSave,
  planReviewSkip,
  reviewDecisionSlot,
  spacedOrderKey,
  type CommandContext,
  type CommandId,
  type DomainResult,
  type Instant,
  type OwnerId,
  type ReviewPeriod,
  type ReviewStatus,
  type UUID,
} from '@yelaxis/domain';

import { noChange } from './alignment-kit';
import type {
  ApplicationResult,
  CanonicalMutation,
  CanonicalRecordState,
  CommandReceipt,
  ExpectedRevision,
} from './contracts';
import { createMutation, updateFrom, type CreatedRecord } from './planning-kit';
import { changed, invalid } from './planning-scheduling-support';
import type { PlanningRecordReader } from './ports';
import type { ReviewDocument, ReviewItemDocument, ReviewListKey } from './review-contracts';
import {
  dailyReviewItems,
  parseReviewInput,
  parseSkipInput,
  periodReviewItems,
  reviewTargetKey,
  reviewTargetRef,
  type DesiredReviewItem,
  type ParsedReviewInput,
} from './review-input';
import {
  reviewDocumentOf,
  reviewEventTypes,
  reviewItemDocumentOf,
  storedDocument,
  type ReviewKit,
  type ReviewSession,
} from './review-kit';
import { parseEndDayInput, type ParsedEndDayInput } from './today-end-day';
import type { TodayCommandPlan } from './today-kit';

/* ───────────────────────── Errors ───────────────────────── */

export const reviewChanged = (): DomainResult<never> =>
  invalid('review_changed', 'This review changed. Review it again.');

const periodNotStarted = (): DomainResult<never> =>
  invalid('review_future', 'This period has not started yet.');

const periodNotOffered = (): DomainResult<never> =>
  invalid(
    'review_period_not_offered',
    'This week does not start on your first day of the week. Open the current weekly review instead.',
  );

/* ───────────────────────── Change sets ───────────────────────── */

/** One command's mutations in order, with the records it creates and per-record event types. */
export interface ChangeSet {
  add(mutation: CanonicalMutation, eventType: string | undefined): void;
  /** Add a shared planner's result as it planned it. */
  addPlan(plan: {
    readonly mutations: readonly CanonicalMutation[];
    readonly created?: readonly CreatedRecord[];
    readonly eventTypeFor?: (mutation: CanonicalMutation) => string | undefined;
  }): void;
  created(record: CreatedRecord): void;
  size(): number;
  plan(): TodayCommandPlan;
}

export function createChangeSet(): ChangeSet {
  const mutations: CanonicalMutation[] = [];
  const created: CreatedRecord[] = [];
  const types = new Map<string, string>();
  const add = (mutation: CanonicalMutation, eventType: string | undefined): void => {
    mutations.push(mutation);
    if (eventType !== undefined) types.set(entityRefKey(mutation.ref), eventType);
  };
  return {
    add,
    addPlan(plan) {
      for (const mutation of plan.mutations) add(mutation, plan.eventTypeFor?.(mutation));
      created.push(...(plan.created ?? []));
    },
    created(record) {
      created.push(record);
    },
    size: () => mutations.length,
    plan: () => ({
      mutations,
      created,
      eventTypeFor: (mutation) => types.get(entityRefKey(mutation.ref)),
    }),
  };
}

/* ───────────────────────── The saved review ───────────────────────── */

/** A period's saved review as read before a command. */
export interface SavedReviewRecords {
  /** The one non-archived review of the period, or null. */
  readonly record: CanonicalRecordState | null;
  /** Its active items (read again inside the command). */
  readonly items: readonly CanonicalRecordState[];
  /** The review at the revision the person saw, and its items as read here. */
  readonly expected: readonly ExpectedRevision[];
}

export function reviewStatusOf(record: CanonicalRecordState | null): ReviewStatus {
  if (record === null) return 'not_started';
  const state = reviewDocumentOf(record).state;
  return state === 'archived' ? 'not_started' : state;
}

/**
 * Read a period's saved review before a command and check that the person may change it: the
 * period has started; an unsaved weekly period starts on the current first weekday (a saved draft
 * stays editable after a first-weekday change); the input names the saved review's revision exactly
 * when one exists; and `allowed` accepts its status.
 */
export async function readSavedReview(
  kit: ReviewKit,
  session: ReviewSession,
  period: ReviewPeriod,
  revision: number | undefined,
  allowed: (status: ReviewStatus) => DomainResult<unknown>,
  options: { readonly items: boolean },
): Promise<DomainResult<SavedReviewRecords>> {
  const { ownerId, profile, today } = session;
  if (!isReviewablePeriod(period, today)) return periodNotStarted();
  const record = await kit.queries.getReviewRecord(ownerId, profile.profileId, period);
  if (record === null && !isAlignedReviewPeriod(period, profile.weekStart))
    return periodNotOffered();
  if (record === null ? revision !== undefined : revision === undefined) return reviewChanged();
  const status = allowed(reviewStatusOf(record));
  if (!status.ok) return status;
  if (record === null || revision === undefined)
    return ok({ record: null, items: [], expected: [] });
  const items = options.items
    ? (await kit.queries.listReviewItems(ownerId, record.ref.id)).map((row) => row.record)
    : [];
  return ok({
    record,
    items,
    expected: [
      { ref: record.ref, revision },
      ...items.map((item) => ({ ref: item.ref, revision: item.localRevision })),
    ],
  });
}

/**
 * The saved review read again inside the command, and its status: it must still be this period's
 * active review. Null when the period had no review before the command.
 */
export async function currentReview(
  records: PlanningRecordReader,
  period: ReviewPeriod,
  saved: SavedReviewRecords,
): Promise<DomainResult<CanonicalRecordState | null>> {
  if (saved.record === null) return ok(null);
  const current = await records.read(saved.record.ref);
  const document = current === null ? undefined : reviewDocumentOf(current);
  if (
    current === null ||
    document === undefined ||
    document.state === 'archived' ||
    document.reviewType !== period.type ||
    document.periodStart !== period.start ||
    document.periodEnd !== period.end
  )
    return reviewChanged();
  return ok(current);
}

/* ───────────────────────── Documents ───────────────────────── */

/** The fields every review document of the period shares. */
function periodFields(profileId: UUID, period: ReviewPeriod): Omit<ReviewDocument, 'state'> {
  return {
    profileId,
    reviewType: period.type,
    periodKey: period.key,
    periodStart: period.start,
    periodEnd: period.end,
    ...(period.type === 'weekly' && period.weekStart !== undefined
      ? { weekStart: period.weekStart }
      : {}),
  };
}

/**
 * The ordered lists an input empties on purpose: those it names as `[]`. An omitted list is left as
 * the plan has it and a non-empty one is stored as items, so neither is cleared. Stored on the
 * review so a resumed draft starts the list from no items, as the person left it. Sorted and unique
 * by construction.
 */
function clearedReviewLists(input: ParsedReviewInput): readonly ReviewListKey[] {
  switch (input.type) {
    case 'daily':
      return input.endDay.nextFocus?.length === 0 ? ['next_focus'] : [];
    case 'weekly':
      return [
        ...(input.commitments?.length === 0 ? (['commitments'] as const) : []),
        ...(input.firstDayFocus?.length === 0 ? (['first_day_focus'] as const) : []),
      ];
    case 'monthly':
    case 'yearly':
      return [];
  }
}

/** The review document a Save or Finish writes: the person's current notes and choices. */
export function reviewDocument(
  profileId: UUID,
  input: ParsedReviewInput,
  state: 'draft' | 'completed',
  completedAt?: Instant,
): ReviewDocument {
  const cleared = clearedReviewLists(input);
  return {
    ...periodFields(profileId, input.period),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.type === 'daily' && input.energy !== undefined ? { energy: input.energy } : {}),
    // The theme and a new direction are stored as the planning text rule stores them (trimmed).
    ...(input.type === 'monthly' && input.theme !== undefined
      ? { themeText: input.theme.trim() }
      : {}),
    ...(input.type === 'yearly' && input.direction !== undefined
      ? {
          directionChoice: input.direction.choice,
          ...(input.direction.text === undefined
            ? {}
            : { directionText: input.direction.text.trim() }),
        }
      : {}),
    ...(cleared.length === 0 ? {} : { clearedLists: cleared }),
    state,
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function itemDocument(
  reviewId: UUID,
  item: DesiredReviewItem,
  orderKey: string,
): ReviewItemDocument {
  return {
    reviewId,
    target: item.target,
    decision: item.decision,
    ...(item.period === undefined ? {} : { period: item.period }),
    ...(item.note === undefined ? {} : { note: item.note }),
    orderKey,
  };
}

/** Structural equality of stored JSON documents. */
export function sameDocument(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null)
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameDocument(leftRecord[key], rightRecord[key]),
    )
  );
}

/* ───────────────────────── Items ───────────────────────── */

/** Every chosen target must still exist for the owner (its Routine for an occurrence). */
export async function checkTargets(
  records: PlanningRecordReader,
  ownerId: OwnerId,
  desired: readonly DesiredReviewItem[],
): Promise<DomainResult<true>> {
  const seen = new Set<string>();
  for (const item of desired) {
    const ref = reviewTargetRef(ownerId, item.target);
    const key = entityRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    if ((await records.read(ref)) === null) return changed('target_missing');
  }
  return ok(true);
}

interface CurrentItem {
  readonly record: CanonicalRecordState;
  readonly document: ReviewItemDocument;
  /** Target and decision slot; null for a deleted or legacy target, which never matches. */
  readonly key: string | null;
}

/**
 * Turn the saved items into the chosen ones, matched by target and decision slot: removed choices
 * are archived (never deleted), changed ones updated, and new ones created with new ids. Order keys
 * follow the person's order.
 */
async function planItems(
  records: PlanningRecordReader,
  ownerId: OwnerId,
  reviewId: UUID,
  saved: readonly CanonicalRecordState[],
  desired: readonly DesiredReviewItem[],
  nextId: () => UUID,
  now: Instant,
  changes: ChangeSet,
): Promise<DomainResult<true>> {
  const current: CurrentItem[] = [];
  for (const prior of saved) {
    const record = await records.read(prior.ref);
    const document = record === null ? undefined : reviewItemDocumentOf(record);
    if (
      record === null ||
      document === undefined ||
      document.reviewId !== reviewId ||
      document.archivedAt !== undefined
    )
      return reviewChanged();
    const target = reviewTargetKey(document.target);
    current.push({
      record,
      document,
      key: target === null ? null : `${target}|${reviewDecisionSlot(document.decision)}`,
    });
  }
  const wanted = new Set(desired.map((item) => item.key));
  const kept = new Map<string, CurrentItem>();
  const removed: CurrentItem[] = [];
  for (const item of current) {
    // A decision about a permanently deleted object (or a legacy kind) is no longer a choice the
    // form can show or change: it stays exactly as it is, as "Deleted object" with its note
    // (placement contract, permanent delete rule 6), and is never applied.
    if (item.key === null) continue;
    if (wanted.has(item.key) && !kept.has(item.key)) kept.set(item.key, item);
    else removed.push(item);
  }

  // Removed choices first, then changed ones, then new ones.
  for (const item of removed)
    changes.add(
      updateFrom(item.record, storedDocument({ ...item.document, archivedAt: now })),
      reviewEventTypes.itemRemoved,
    );
  const additions: CanonicalMutation[] = [];
  for (const [index, item] of desired.entries()) {
    const next = itemDocument(reviewId, item, spacedOrderKey(index));
    const existing = kept.get(item.key);
    if (existing === undefined) {
      const ref = createEntityRef('review_item', nextId(), ownerId);
      additions.push(createMutation(ref, storedDocument(next)));
      changes.created({ ref, kind: 'review_item' });
    } else if (!sameDocument(existing.document, next)) {
      changes.add(updateFrom(existing.record, storedDocument(next)), reviewEventTypes.itemSaved);
    }
  }
  for (const mutation of additions) changes.add(mutation, reviewEventTypes.itemSaved);
  return ok(true);
}

export interface ReviewWrite {
  readonly session: ReviewSession;
  readonly records: PlanningRecordReader;
  readonly context: CommandContext;
  readonly input: ParsedReviewInput;
  readonly saved: SavedReviewRecords;
  /** The saved review read again inside the command (`currentReview`). */
  readonly current: CanonicalRecordState | null;
  readonly desired: readonly DesiredReviewItem[];
  readonly state: 'draft' | 'completed';
  readonly eventType: string;
}

/**
 * Write the review and its items as a Save or Finish leaves them. The review is created, or it is
 * updated whenever anything changes, so its revision always names the whole saved review. When
 * nothing changes at all the command is `no_change`.
 */
export async function writeReview(
  kit: ReviewKit,
  write: ReviewWrite,
  changes: ChangeSet,
): Promise<DomainResult<true>> {
  const { ownerId, profile } = write.session;
  const document = reviewDocument(
    profile.profileId,
    write.input,
    write.state,
    write.state === 'completed' ? write.context.now : undefined,
  );
  const ref = write.current?.ref ?? createEntityRef('review', kit.nextId(), ownerId);
  const items = createChangeSet();
  const planned = await planItems(
    write.records,
    ownerId,
    ref.id,
    write.saved.items,
    write.desired,
    kit.nextId,
    write.context.now,
    items,
  );
  if (!planned.ok) return planned;
  if (write.current === null) {
    changes.add(createMutation(ref, storedDocument(document)), write.eventType);
    changes.created({ ref, kind: 'review' });
  } else if (items.size() > 0 || !sameDocument(write.current.document, document)) {
    changes.add(updateFrom(write.current, storedDocument(document)), write.eventType);
  } else return noChange();
  changes.addPlan(items.plan());
  return ok(true);
}

/* ───────────────────────── Save ───────────────────────── */

/** A Save or Finish request, checked and read before its command. */
export interface PreparedReview {
  readonly input: ParsedReviewInput;
  readonly saved: SavedReviewRecords;
  readonly desired: readonly DesiredReviewItem[];
  /** Daily only: the End Day choices exactly as End Day checks them. */
  readonly endDay?: ParsedEndDayInput;
}

/**
 * The chosen items, checked without reading the plan. A daily review is End Day: its
 * choices pass End Day's own checks, with the carry date required on Finish only (Save ignores it).
 */
function reviewChoices(
  input: ParsedReviewInput,
  session: ReviewSession,
  mode: 'save' | 'finish',
): DomainResult<Pick<PreparedReview, 'desired' | 'endDay'>> {
  if (input.type !== 'daily') {
    const desired = periodReviewItems(input, session.ownerId);
    return desired.ok ? ok({ desired: desired.value }) : desired;
  }
  if (!isReviewablePeriod(input.period, session.today)) return periodNotStarted();
  const carry = endDayCarryDate(input.period.start, session.today);
  if (!carry.ok) return carry;
  const { endDay } = input;
  const parsed = parseEndDayInput(
    {
      date: input.period.key,
      carryTo: mode === 'finish' ? (endDay.carryTo ?? '') : carry.value,
      actions: endDay.actions,
      occurrences: endDay.occurrences,
      ...(endDay.nextFocus === undefined ? {} : { nextFocus: endDay.nextFocus }),
    },
    session,
  );
  if (!parsed.ok) return parsed;
  const desired = dailyReviewItems(parsed.value, session.ownerId);
  return desired.ok ? ok({ desired: desired.value, endDay: parsed.value }) : desired;
}

/** Check a Save or Finish input completely, then read the period's saved review. */
export async function prepareReview(
  kit: ReviewKit,
  session: ReviewSession,
  raw: unknown,
  mode: 'save' | 'finish',
): Promise<DomainResult<PreparedReview>> {
  const input = parseReviewInput(raw, session.ownerId);
  if (!input.ok) return input;
  const choices = reviewChoices(input.value, session, mode);
  if (!choices.ok) return choices;
  const saved = await readSavedReview(
    kit,
    session,
    input.value.period,
    input.value.revision,
    mode === 'save' ? planReviewSave : planReviewFinish,
    { items: true },
  );
  if (!saved.ok) return saved;
  return ok({ input: input.value, saved: saved.value, ...choices.value });
}

/** Save a draft: the first save creates it, a skipped review is resumed, nothing is applied. */
export async function saveReview(
  kit: ReviewKit,
  raw: unknown,
  commandId: CommandId | undefined,
): Promise<ApplicationResult<CommandReceipt>> {
  const session = await kit.session();
  const prepared = await prepareReview(kit, session, raw, 'save');
  return kit.run(
    session.ownerId,
    commandId,
    reviewEventTypes.saved,
    prepared.ok ? prepared.value.saved.expected : [],
    async ({ records, context }) => {
      if (!prepared.ok) return prepared;
      const { input, saved, desired } = prepared.value;
      const current = await currentReview(records, input.period, saved);
      if (!current.ok) return current;
      const allowed = planReviewSave(reviewStatusOf(current.value));
      if (!allowed.ok) return allowed;
      const targets = await checkTargets(records, session.ownerId, desired);
      if (!targets.ok) return targets;
      const changes = createChangeSet();
      const written = await writeReview(
        kit,
        {
          session,
          records,
          context,
          input,
          saved,
          current: current.value,
          desired,
          state: 'draft',
          eventType: reviewEventTypes.saved,
        },
        changes,
      );
      return written.ok ? ok(changes.plan()) : written;
    },
  );
}

/* ───────────────────────── Skip ───────────────────────── */

/** Skip: a new or draft review becomes skipped; its saved choices stay and nothing is applied. */
export async function skipReview(
  kit: ReviewKit,
  raw: unknown,
  commandId: CommandId | undefined,
): Promise<ApplicationResult<CommandReceipt>> {
  const session = await kit.session();
  const { ownerId, profile } = session;
  const prepared = await (async (): Promise<
    DomainResult<{ readonly period: ReviewPeriod; readonly saved: SavedReviewRecords }>
  > => {
    const input = parseSkipInput(raw);
    if (!input.ok) return input;
    const { period, revision } = input.value.base;
    const saved = await readSavedReview(kit, session, period, revision, planReviewSkip, {
      items: false,
    });
    return saved.ok ? ok({ period, saved: saved.value }) : saved;
  })();
  return kit.run(
    ownerId,
    commandId,
    reviewEventTypes.skipped,
    prepared.ok ? prepared.value.saved.expected : [],
    async ({ records }) => {
      if (!prepared.ok) return prepared;
      const { period, saved } = prepared.value;
      const current = await currentReview(records, period, saved);
      if (!current.ok) return current;
      const allowed = planReviewSkip(reviewStatusOf(current.value));
      if (!allowed.ok) return allowed;
      const changes = createChangeSet();
      if (current.value === null) {
        const ref = createEntityRef('review', kit.nextId(), ownerId);
        const document: ReviewDocument = {
          ...periodFields(profile.profileId, period),
          state: 'skipped',
        };
        changes.add(createMutation(ref, storedDocument(document)), reviewEventTypes.skipped);
        changes.created({ ref, kind: 'review' });
      } else {
        const document: ReviewDocument = {
          ...reviewDocumentOf(current.value),
          state: 'skipped',
        };
        changes.add(updateFrom(current.value, storedDocument(document)), reviewEventTypes.skipped);
      }
      return ok(changes.plan());
    },
  );
}
