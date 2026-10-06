/**
 * Shared focus planning. It turns a date's chosen focus into canonical
 * mutations inside a command transaction and is used by `addFocus` and `setDayFocus` and by End
 * Day's focus for the carry date. Selecting, removing, or reordering never changes the target's
 * state, placement, block, priority, or order anywhere else.
 */
import {
  compareOrder,
  createEntityRef,
  entityRefKey,
  err,
  focusTargetKey,
  isOccurrenceOnDate,
  ok,
  parseCalendarDate,
  parseUUID,
  planDayFocus,
  validateFocusDate,
  validateFocusTarget,
  weekdays,
  type CalendarDate,
  type CommandContext,
  type DayFocusItem,
  type DomainResult,
  type EntityRef,
  type FocusTargetKey,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import type { ActionCanonicalDocument } from './actions';
import type { CanonicalMutation, CanonicalRecordState, ExpectedRevision } from './contracts';
import type { FocusSelectionDocument, OccurrenceTargetInput } from './planning-contracts';
import { createMutation, updateFrom, type CreatedRecord } from './planning-kit';
import {
  occurrenceRefFor,
  openOccurrence,
  validateOccurrenceDocument,
} from './planning-routines-occurrences';
import { changed, invalid } from './planning-scheduling-support';
import type { PlanningRecordReader } from './ports';
import type { DayFocusRow, FocusTargetInput } from './today-contracts';
import { focusRowKey } from './today-day';
import type { TodayKit } from './today-kit';

/** Per-record event types of focus changes. Payloads carry only `{ operation }`. */
export const focusEventTypes = Object.freeze({
  added: 'focus.added',
  removed: 'focus.removed',
  reordered: 'focus.reordered',
  materialized: 'routine_occurrence.materialized',
});

/* ───────────────────────── Targets ───────────────────────── */

/** A validated focus target input: its day key and the record a command reads to add it. */
export type ParsedFocusTarget =
  | {
      readonly kind: 'action';
      readonly key: FocusTargetKey;
      readonly ref: EntityRef<'action'>;
    }
  | {
      readonly kind: 'routine_occurrence';
      readonly key: FocusTargetKey;
      /** The deterministic occurrence ref (materialized or not). */
      readonly ref: EntityRef<'routine_occurrence'>;
      readonly occurrence: OccurrenceTargetInput;
    };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDate = (value: unknown): boolean =>
  typeof value === 'string' && parseCalendarDate(value).ok;

/** A period shaped like a generated occurrence period (the Routine checks it is really generated). */
function isOccurrencePeriod(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'date') return isDate(value['date']);
  const count = value['targetCount'];
  return (
    value['kind'] === 'week' &&
    isDate(value['start']) &&
    isDate(value['end']) &&
    weekdays.some((weekday) => weekday === value['weekStart']) &&
    typeof count === 'number' &&
    Number.isInteger(count) &&
    count > 0
  );
}

/** Validate one focus target input from the UI and compute its key; nothing is read. */
export function parseFocusTarget(
  ownerId: OwnerId,
  input: FocusTargetInput,
): DomainResult<ParsedFocusTarget> {
  const raw: unknown = input;
  if (!isRecord(raw)) return invalid('focus_target');
  if (raw['kind'] === 'action') {
    const id = parseUUID(typeof raw['actionId'] === 'string' ? raw['actionId'] : '');
    if (!id.ok) return id;
    return ok({
      kind: 'action',
      key: focusTargetKey({ kind: 'action', actionId: id.value }),
      ref: createEntityRef('action', id.value, ownerId),
    });
  }
  if (raw['kind'] === 'routine_occurrence' && input.kind === 'routine_occurrence') {
    const occurrence = input.occurrence as unknown;
    if (!isRecord(occurrence) || !isOccurrencePeriod(occurrence['period']))
      return invalid('focus_target');
    const revision = occurrence['revision'];
    if (revision !== undefined && (!Number.isSafeInteger(revision) || Number(revision) < 1))
      return invalid('focus_target');
    const ref = occurrenceRefFor(ownerId, input.occurrence);
    if (!ref.ok) return ref;
    return ok({
      kind: 'routine_occurrence',
      key: focusTargetKey({ kind: 'routine_occurrence', occurrenceId: ref.value.id }),
      ref: ref.value,
      occurrence: input.occurrence,
    });
  }
  return invalid('focus_target');
}

/** The key of a stored day focus document, or null when it is not a day focus target. */
export function focusSelectionKey(document: FocusSelectionDocument): FocusTargetKey | null {
  switch (document.target.kind) {
    case 'action':
      return focusTargetKey({ kind: 'action', actionId: document.target.actionId });
    case 'routine_occurrence':
      return focusTargetKey({
        kind: 'routine_occurrence',
        occurrenceId: document.target.routineOccurrenceId,
      });
    case 'project':
    case 'milestone':
      return null;
  }
}

/* ───────────────────────── Pre-reads ───────────────────────── */

/** A date's active focus, read before a command opens (outside the transaction). */
export interface DayFocusRecords {
  /** The rows as the query port lists them, in (order key, id) order. */
  readonly rows: readonly DayFocusRow[];
  /** The canonical records of those rows, for `planFocusMutations` (`existing`). */
  readonly records: readonly CanonicalRecordState[];
  /** Their current revisions, for the command's expected list. */
  readonly expected: readonly ExpectedRevision[];
  /** Domain items for `appendDayFocus`, `planDayFocus`, and `reorderWithin`. */
  readonly items: readonly DayFocusItem[];
}

export async function readDayFocus(
  kit: TodayKit,
  ownerId: OwnerId,
  profileId: UUID,
  date: CalendarDate,
): Promise<DayFocusRecords> {
  const rows = [...(await kit.queries.listDayFocus(ownerId, profileId, date))].sort(compareOrder);
  const records: CanonicalRecordState[] = [];
  for (const row of rows) {
    const record = await kit.queries.readRecord(
      ownerId,
      createEntityRef('focus_selection', row.id, ownerId),
    );
    if (record !== null) records.push(record);
  }
  return {
    rows,
    records,
    expected: records.map((record) => ({ ref: record.ref, revision: record.localRevision })),
    items: rows.map((row) => ({ id: row.id, orderKey: row.orderKey, targetKey: focusRowKey(row) })),
  };
}

/**
 * The pre-read before a date's focus changes (`addFocus`, `setDayFocus`, and a weekly review's
 * first-day focus): the date must be today or later, and every listed row must still be readable;
 * otherwise the day's focus is changing (`focus_changed`).
 */
export async function prepareDayFocusChange(
  kit: TodayKit,
  session: { readonly ownerId: OwnerId; readonly profileId: UUID; readonly today: CalendarDate },
  date: CalendarDate,
): Promise<DomainResult<DayFocusRecords>> {
  const editable = validateFocusDate(date, session.today);
  if (!editable.ok) return editable;
  const current = await readDayFocus(kit, session.ownerId, session.profileId, date);
  return current.records.length === current.rows.length ? ok(current) : changed('focus_changed');
}

/* ───────────────────────── Planning ───────────────────────── */

export interface FocusMutationRequest {
  readonly ownerId: OwnerId;
  readonly profileId: UUID;
  /** The focus date, already checked with `validateFocusDate`. */
  readonly date: CalendarDate;
  /** The date's active focus records read before the command; their revisions are expected. */
  readonly existing: readonly CanonicalRecordState[];
  /** The complete chosen focus in order: at most three targets, each once. */
  readonly desired: readonly FocusTargetInput[];
}

export interface FocusMutationPlan {
  /** Archives, then order-key updates, then occurrence materializations, then focus creates. */
  readonly mutations: readonly CanonicalMutation[];
  /** New focus selections and newly materialized occurrences, for grouped undo. */
  readonly created: readonly CreatedRecord[];
  /** Per-record event types by `entityRefKey`: see `focusEventTypes`. */
  readonly eventTypes: ReadonlyMap<string, string>;
  readonly eventTypeFor: (mutation: CanonicalMutation) => string | undefined;
}

interface CurrentSelection {
  readonly record: CanonicalRecordState;
  readonly document: FocusSelectionDocument;
}

function notOnDay(): DomainResult<never> {
  return err({
    code: 'invalid_value',
    message: 'This routine occurrence is not on that day.',
    details: { reason: 'not_on_day' },
  });
}

/**
 * Plan a date's focus inside the command transaction. Each existing selection is read again and
 * must still be an active focus row of this profile and date. New targets are checked here: an
 * Action must exist and be unfinished; a Routine Occurrence is opened like any occurrence command,
 * must be planned and on the date, and is materialized as a pristine planned row when needed. Kept
 * selections are never checked again, so finished or changed targets stay until they are removed.
 */
export async function planFocusMutations(
  records: PlanningRecordReader,
  request: FocusMutationRequest,
  nextId: () => UUID,
  context: CommandContext,
): Promise<DomainResult<FocusMutationPlan>> {
  const targets: ParsedFocusTarget[] = [];
  for (const input of request.desired) {
    const parsed = parseFocusTarget(request.ownerId, input);
    if (!parsed.ok) return parsed;
    targets.push(parsed.value);
  }

  const current = new Map<string, CurrentSelection>();
  const items: DayFocusItem[] = [];
  for (const prior of request.existing) {
    const record = await records.read(prior.ref);
    if (record === null) return changed('focus_changed');
    const document = record.document as FocusSelectionDocument;
    const targetKey = focusSelectionKey(document);
    if (
      targetKey === null ||
      document.kind !== 'day_focus' ||
      document.archivedAt !== undefined ||
      document.periodStart !== request.date ||
      document.profileId !== request.profileId
    )
      return changed('focus_changed');
    current.set(record.ref.id, { record, document });
    items.push({ id: record.ref.id, orderKey: document.orderKey, targetKey });
  }

  const plan = planDayFocus(
    items,
    targets.map((target) => target.key),
  );
  if (!plan.ok) return plan;

  const mutations: CanonicalMutation[] = [];
  const created: CreatedRecord[] = [];
  const eventTypes = new Map<string, string>();
  const push = (mutation: CanonicalMutation, eventType: string): void => {
    mutations.push(mutation);
    eventTypes.set(entityRefKey(mutation.ref), eventType);
  };

  for (const id of plan.value.archive) {
    const selection = current.get(id);
    if (selection === undefined) return changed('focus_changed');
    push(
      updateFrom(selection.record, { ...selection.document, archivedAt: context.now }),
      focusEventTypes.removed,
    );
  }
  for (const change of plan.value.reorder) {
    const selection = current.get(change.id);
    if (selection === undefined) return changed('focus_changed');
    push(
      updateFrom(selection.record, { ...selection.document, orderKey: change.orderKey }),
      focusEventTypes.reordered,
    );
  }

  const materialized: CanonicalMutation[] = [];
  const selections: CanonicalMutation[] = [];
  const byKey = new Map(targets.map((target) => [target.key, target]));
  for (const addition of plan.value.create) {
    const target = byKey.get(addition.targetKey);
    if (target === undefined) return changed('focus_changed');
    let documentTarget: FocusSelectionDocument['target'];
    if (target.kind === 'action') {
      const action = await records.read(target.ref);
      if (action === null) return changed('target_missing');
      const focusable = validateFocusTarget({
        kind: 'action',
        state: (action.document as ActionCanonicalDocument).state,
      });
      if (!focusable.ok) return focusable;
      documentTarget = { kind: 'action', actionId: target.ref.id };
    } else {
      const opened = await openOccurrence(records, request.ownerId, target.occurrence);
      if (!opened.ok) return opened;
      const focusable = validateFocusTarget({
        kind: 'routine_occurrence',
        state: opened.value.document.state,
      });
      if (!focusable.ok) return focusable;
      if (!isOccurrenceOnDate(opened.value.document, request.date)) return notOnDay();
      if (opened.value.record === null) {
        const document = validateOccurrenceDocument(
          opened.value.ref,
          opened.value.document,
          context.now,
        );
        if (!document.ok) return document;
        const mutation = createMutation(opened.value.ref, document.value);
        materialized.push(mutation);
        eventTypes.set(entityRefKey(mutation.ref), focusEventTypes.materialized);
        created.push({ ref: opened.value.ref, kind: 'routine_occurrence' });
      }
      documentTarget = { kind: 'routine_occurrence', routineOccurrenceId: opened.value.ref.id };
    }
    const ref = createEntityRef('focus_selection', nextId(), request.ownerId);
    const document: FocusSelectionDocument = {
      kind: 'day_focus',
      profileId: request.profileId,
      target: documentTarget,
      periodStart: request.date,
      periodEnd: request.date,
      orderKey: addition.orderKey,
    };
    const mutation = createMutation(ref, document);
    selections.push(mutation);
    eventTypes.set(entityRefKey(ref), focusEventTypes.added);
    created.push({ ref, kind: 'focus_selection' });
  }
  // Occurrence rows first: a focus selection references its materialized occurrence.
  mutations.push(...materialized, ...selections);

  return ok({
    mutations,
    created,
    eventTypes,
    eventTypeFor: (mutation) => eventTypes.get(entityRefKey(mutation.ref)),
  });
}
