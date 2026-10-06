/**
 * Today and Focus Part 3 — End Day. A short, plan-scoped look back at one planning date on
 * or before today: what is done, what is still open, and the carry date's focus.
 *
 * Every open item defaults to "Decide later", which changes nothing. `applyEndDay` applies only the
 * person's explicit choices, and optionally the carry date's focus, as one command with expected
 * revisions, minimized `{ operation }` events with per-record types, a receipt, and one grouped
 * `planning.restore_v1` undo. Nothing is decided, ranked, or moved for the person.
 *
 * The command is three shared steps — `parseEndDayInput`, `prepareEndDay` (pre-reads), and
 * `planEndDayMutations` (inside the transaction) — that the Review daily review's Finish runs too, so
 * End Day decisions have exactly one mutation path.
 */
import {
  completeOccurrenceProgress,
  createDayPeriod,
  createEntityRef,
  endDayCarryDate,
  endDayDecisionKinds,
  endDayLimits,
  err,
  intervalsIntersect,
  isFocusableActionState,
  isOccurrenceOnDate,
  localDayBounds,
  ok,
  parseCalendarDate,
  parseUUID,
  periodContaining,
  planDayFocus,
  planEndDayAction,
  skipOccurrenceProgress,
  validateEndDayPeriod,
  validateTimeBlockTransition,
  type CalendarDate,
  type CommandContext,
  type CommandId,
  type DomainResult,
  type EndDayDecisionKind,
  type EntityRef,
  type HorizonPeriod,
  type OwnerId,
  type UUID,
  type Weekday,
} from '@yelaxis/domain';

import type { ActionCanonicalDocument } from './actions';
import { noChange } from './alignment-kit';
import type {
  ApplicationResult,
  CanonicalMutation,
  CanonicalRecordState,
  CommandReceipt,
  ExpectedRevision,
} from './contracts';
import type {
  ActionSummary,
  BlockRow,
  FocusSelectionDocument,
  OccurrenceTargetInput,
  PlanProfile,
  PlanningPlacementDocument,
  TimeBlockDocument,
} from './planning-contracts';
import { createMutation, updateFrom, type CreatedRecord } from './planning-kit';
import { compareOrder, isActionPlacement, placedAction } from './planning-projections-range';
import {
  occurrenceRefFor,
  openOccurrence,
  validateOccurrenceDocument,
  withProgress,
} from './planning-routines-occurrences';
import {
  actionWithState,
  changed,
  expectedOf,
  invalid,
  isCurrentPlanned,
  missing,
  placementTarget,
  placementTargetId,
  rejected,
  timeBlockSnapshot,
  upsertPlacement,
} from './planning-scheduling-support';
import type { PlanningRecordReader } from './ports';
import type {
  DayFocusRow,
  EndDayInput,
  EndDayItemView,
  EndDayOccurrenceDecision,
  EndDayView,
  FocusActionRow,
  FocusChoices,
  FocusTargetInput,
  TodayEndDayMethods,
} from './today-contracts';
import { loadDay, loadFocusChoices, type LoadedDay } from './today-day';
import {
  parseFocusTarget,
  planFocusMutations,
  readDayFocus,
  type DayFocusRecords,
  type ParsedFocusTarget,
} from './today-focus-plan';
import {
  eventTypesByRecord,
  requireTodayDate,
  type TodayKit,
  type TodaySession,
} from './today-kit';

/** The command's own event type; every changed record carries its own type (below). */
export const endDayEventType = 'day.ended';

/** Per-record event types of End Day changes. Payloads carry only `{ operation }`. */
export const endDayEventTypes = Object.freeze({
  action: Object.freeze({
    carry: 'action.carried',
    move: 'action.moved',
    complete: 'action.completed',
    cancel: 'action.canceled',
  } satisfies Record<EndDayDecisionKind, string>),
  block: Object.freeze({
    skipped: 'time_block.skipped',
    completed: 'time_block.completed',
    canceled: 'time_block.canceled',
  }),
  placement: 'planning.placed',
  occurrence: Object.freeze({
    complete: 'routine_occurrence.completed',
    skip: 'routine_occurrence.skipped',
  } satisfies Record<EndDayOccurrenceDecision['kind'], string>),
});

export function createTodayEndDay(kit: TodayKit): TodayEndDayMethods {
  return {
    getEndDay: (date) => readEndDay(kit, date),
    applyEndDay: (input, commandId) => applyEndDay(kit, input, commandId),
  };
}

/* ───────────────────────── Read ───────────────────────── */

/**
 * End Day for one date. When End Day is not available (a later date), nothing is read beyond the
 * session: the lists and the focus choices are empty and `carryTo` is the date itself.
 */
export async function readEndDay(kit: TodayKit, value: string): Promise<EndDayView> {
  const date = requireTodayDate(value);
  const session = await kit.session();
  const { profile, today } = session;
  const carry = endDayCarryDate(date, today);
  if (!carry.ok)
    return {
      profile,
      date,
      today,
      available: false,
      carryTo: date,
      completed: [],
      open: { items: [], total: 0 },
      nextFocus: emptyChoices(profile, date, today),
    };
  const day = await loadDay(kit, session, date);
  const items = await endDayItems(kit, session, day);
  const next = await loadDay(kit, session, carry.value);
  return {
    profile,
    date,
    today,
    available: true,
    carryTo: carry.value,
    completed: items.completed,
    open: { items: items.open.slice(0, endDayLimits.actions), total: items.open.length },
    nextFocus: await loadFocusChoices(kit, session, next),
  };
}

function emptyChoices(profile: PlanProfile, date: CalendarDate, today: CalendarDate): FocusChoices {
  return { profile, date, editable: date >= today, current: [], candidates: [], weekTotal: 0 };
}

/** The plain Action summary of a Focus mode row (End Day never shows the note). */
function summaryOf(row: FocusActionRow): ActionSummary {
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    localRevision: row.localRevision,
    orderKey: row.orderKey,
    ...(row.estimateMinutes === undefined ? {} : { estimateMinutes: row.estimateMinutes }),
    ...(row.energy === undefined ? {} : { energy: row.energy }),
    ...(row.priority === undefined ? {} : { priority: row.priority }),
    ...(row.due === undefined ? {} : { due: row.due }),
    ...(row.axisTitle === undefined ? {} : { axisTitle: row.axisTitle }),
    ...(row.projectTitle === undefined ? {} : { projectTitle: row.projectTitle }),
    ...(row.placement === undefined ? {} : { placement: row.placement }),
  };
}

/**
 * The day's items, plan-scoped. Open, in this order: Actions with a planned
 * block on the day (timeline order), unfinished Actions placed on the day (placement order),
 * unfinished Actions only in the day's focus (focus order), then the day's planned dated Routine
 * Occurrences. Done: completed Actions scheduled or placed on the day, then its completed dated
 * occurrences. Weekly counts, Commitments, and custom blocks are not listed.
 *
 * An open Action that is not scheduled on the day but has a planned block on another day carries
 * that `block`: it gets no decision here ("Change it from that day").
 */
async function endDayItems(
  kit: TodayKit,
  session: TodaySession,
  day: LoadedDay,
): Promise<{ readonly open: EndDayItemView[]; readonly completed: EndDayItemView[] }> {
  const { ownerId } = session;
  const placed = day.snapshot.placements
    .filter(isActionPlacement)
    .filter((row) => row.period.kind === 'day' && row.period.date === day.date)
    .sort(compareOrder);
  const placedById = new Map(placed.map((row) => [row.target.action.id, placedAction(row)]));

  // Each Action's block on the day, in timeline order; a planned block wins over a resolved one.
  const dayBlocks = new Map<UUID, BlockRow>();
  for (const entry of day.column.timed) {
    const block = entry.block;
    if (block?.target.kind !== 'action') continue;
    const known = dayBlocks.get(block.target.actionId);
    if (known === undefined || (known.state !== 'planned' && block.state === 'planned'))
      dayBlocks.set(block.target.actionId, block);
  }

  const open: EndDayItemView[] = [];
  const completed: EndDayItemView[] = [];
  const listed = new Set<UUID>();

  for (const [actionId, block] of dayBlocks) {
    // A block that began the day before keeps its Action's Day placement there: read the Action.
    let action = placedById.get(actionId);
    if (action === undefined) {
      const row = await kit.queries.getFocusAction(ownerId, actionId);
      if (row === null) continue;
      action = summaryOf(row);
    }
    if (block.state === 'planned' && isFocusableActionState(action.state)) {
      open.push({ kind: 'action', action, source: 'scheduled', block });
      listed.add(actionId);
    } else if (action.state === 'completed') {
      completed.push({ kind: 'action', action, source: 'scheduled', block });
      listed.add(actionId);
    }
  }

  /** An open Action without a planned block on the day, with its planned block elsewhere. */
  const openAction = async (
    action: ActionSummary,
    source: 'flexible' | 'focus',
  ): Promise<EndDayItemView> => {
    // Only a scheduled or in-progress Action can hold a planned block (planning scheduling rules).
    if (action.state !== 'scheduled' && action.state !== 'in_progress')
      return { kind: 'action', action, source };
    const row = await kit.queries.getFocusAction(ownerId, action.id);
    const block = row?.plannedBlock;
    return { kind: 'action', action, source, ...(block === undefined ? {} : { block }) };
  };

  for (const row of placed) {
    const action = placedAction(row);
    if (listed.has(action.id)) continue;
    if (isFocusableActionState(action.state)) {
      open.push(await openAction(action, 'flexible'));
      listed.add(action.id);
    } else if (action.state === 'completed') {
      completed.push({ kind: 'action', action, source: 'flexible' });
      listed.add(action.id);
    }
  }

  for (const row of day.focusRows) {
    if (row.target.kind !== 'action') continue;
    const action = row.target.action;
    if (listed.has(action.id) || !isFocusableActionState(action.state)) continue;
    open.push(await openAction(action, 'focus'));
    listed.add(action.id);
  }

  for (const occurrence of day.dayOccurrences) {
    if (occurrence.ref.period.kind !== 'date') continue;
    if (occurrence.state === 'planned') open.push({ kind: 'routine_occurrence', occurrence });
    else if (occurrence.state === 'completed')
      completed.push({ kind: 'routine_occurrence', occurrence });
  }
  return { open, completed };
}

/* ───────────────────────── Command input ───────────────────────── */

export type ParsedActionDecision =
  | { readonly kind: 'carry' | 'complete' | 'cancel' }
  | { readonly kind: 'move'; readonly period: HorizonPeriod };

export interface ParsedActionItem {
  readonly ref: EntityRef<'action'>;
  readonly revision: number;
  readonly decision: ParsedActionDecision;
}

export interface ParsedOccurrenceItem {
  readonly ref: EntityRef<'routine_occurrence'>;
  readonly occurrence: OccurrenceTargetInput;
  readonly decision: EndDayOccurrenceDecision['kind'];
}

/** A validated End Day request: every choice checked, nothing read from the plan yet. */
export interface ParsedEndDayInput {
  readonly date: CalendarDate;
  readonly carryTo: CalendarDate;
  readonly actions: readonly ParsedActionItem[];
  readonly occurrences: readonly ParsedOccurrenceItem[];
  readonly nextFocus?: readonly FocusTargetInput[];
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const endDayError = (reason: string, message: string): DomainResult<never> =>
  err({ code: 'invalid_value', message, details: { reason } });

const limitError = (): DomainResult<never> =>
  endDayError(
    'end_day_limit',
    'End day applies up to 200 Actions and 100 routine occurrences at a time.',
  );

const dayChanged = (): DomainResult<never> =>
  endDayError('end_day_day_changed', 'The day changed. Review your choices again.');

const actionNotOnDay = (): DomainResult<never> =>
  endDayError('not_on_day', 'This Action is no longer planned for this day. Review it again.');

const occurrenceNotOnDay = (): DomainResult<never> =>
  endDayError('not_on_day', 'This routine occurrence is not on this day.');

const focusConflict = (): DomainResult<never> =>
  endDayError(
    'focus_conflicts_decision',
    'An Action you complete or cancel cannot also be chosen as focus. Remove it from the focus or choose another option.',
  );

const occurrenceDecisionKinds: readonly EndDayOccurrenceDecision['kind'][] = ['complete', 'skip'];
const moveKinds: readonly HorizonPeriod['kind'][] = ['day', 'week', 'month', 'year'];

function parseActionDecision(
  raw: unknown,
  today: CalendarDate,
  weekStart: Weekday,
): DomainResult<ParsedActionDecision> {
  if (!isRecord(raw)) return invalid('end_day_decision');
  const kind = endDayDecisionKinds.find((candidate) => candidate === raw['kind']);
  if (kind === undefined) return invalid('end_day_decision');
  if (kind !== 'move') return ok({ kind });
  const input = raw['period'];
  if (!isRecord(input)) return invalid('period');
  const periodKind = moveKinds.find((candidate) => candidate === input['kind']);
  if (periodKind === undefined) return invalid('period');
  const period = periodContaining(
    periodKind,
    typeof input['date'] === 'string' ? input['date'] : '',
    weekStart,
  );
  if (!period.ok) return period;
  const allowed = validateEndDayPeriod(period.value, today);
  if (!allowed.ok) return allowed;
  return ok({ kind, period: allowed.value });
}

/**
 * Validate the whole input before anything is read: dates, the carry date, limits, unique
 * targets, decision kinds, move periods, and the focus rules. Nothing here reads the plan.
 */
export function parseEndDayInput(
  input: EndDayInput,
  session: TodaySession,
): DomainResult<ParsedEndDayInput> {
  const raw: unknown = input;
  if (!isRecord(raw)) return invalid('end_day_input');
  const { ownerId, profile, today } = session;
  const date = parseCalendarDate(typeof raw['date'] === 'string' ? raw['date'] : '');
  if (!date.ok) return date;
  const carryTo = parseCalendarDate(typeof raw['carryTo'] === 'string' ? raw['carryTo'] : '');
  if (!carryTo.ok) return carryTo;
  const expectedCarry = endDayCarryDate(date.value, today);
  if (!expectedCarry.ok) return expectedCarry;
  if (expectedCarry.value !== carryTo.value) return dayChanged();

  const rawActions = raw['actions'];
  const rawOccurrences = raw['occurrences'];
  if (!Array.isArray(rawActions) || !Array.isArray(rawOccurrences)) return invalid('end_day_input');
  if (rawActions.length > endDayLimits.actions || rawOccurrences.length > endDayLimits.occurrences)
    return limitError();

  const actions: ParsedActionItem[] = [];
  for (const item of rawActions as unknown[]) {
    if (!isRecord(item)) return invalid('end_day_input');
    const id = parseUUID(typeof item['actionId'] === 'string' ? item['actionId'] : '');
    if (!id.ok) return id;
    const revision = item['revision'];
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1)
      return invalid('revision');
    if (actions.some((known) => known.ref.id === id.value)) return invalid('duplicate_action');
    const decision = parseActionDecision(item['decision'], today, profile.weekStart);
    if (!decision.ok) return decision;
    actions.push({
      ref: createEntityRef('action', id.value, ownerId),
      revision,
      decision: decision.value,
    });
  }

  const occurrences: ParsedOccurrenceItem[] = [];
  for (const item of rawOccurrences as unknown[]) {
    if (!isRecord(item)) return invalid('end_day_input');
    const rawDecision = item['decision'];
    const rawOccurrence = item['occurrence'];
    if (!isRecord(rawDecision) || !isRecord(rawOccurrence)) return invalid('end_day_input');
    const decision = occurrenceDecisionKinds.find((candidate) => candidate === rawDecision['kind']);
    if (decision === undefined) return invalid('end_day_decision');
    const occurrence = rawOccurrence as unknown as OccurrenceTargetInput;
    // End Day lists dated occurrences only; a weekly count is changed from its Routine.
    const period: unknown = occurrence.period;
    if (!isRecord(period) || period['kind'] !== 'date') return occurrenceNotOnDay();
    const revision: unknown = occurrence.revision;
    if (
      revision !== undefined &&
      (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1)
    )
      return invalid('revision');
    const ref = occurrenceRefFor(ownerId, occurrence);
    if (!ref.ok) return ref;
    if (occurrences.some((known) => known.ref.id === ref.value.id))
      return invalid('duplicate_occurrence');
    occurrences.push({ ref: ref.value, occurrence, decision });
  }

  const rawFocus = raw['nextFocus'];
  if (rawFocus === undefined)
    return ok({ date: date.value, carryTo: carryTo.value, actions, occurrences });
  if (!Array.isArray(rawFocus)) return invalid('focus_target');
  const nextFocus = rawFocus as readonly FocusTargetInput[];
  const targets: ParsedFocusTarget[] = [];
  for (const target of nextFocus) {
    const parsed = parseFocusTarget(ownerId, target);
    if (!parsed.ok) return parsed;
    targets.push(parsed.value);
  }
  // At most three, each once: the same rules as choosing focus anywhere else.
  const shape = planDayFocus(
    [],
    targets.map((target) => target.key),
  );
  if (!shape.ok) return shape;
  const resolving = new Set(
    actions
      .filter((item) => item.decision.kind === 'complete' || item.decision.kind === 'cancel')
      .map((item) => item.ref.id),
  );
  if (targets.some((target) => target.kind === 'action' && resolving.has(target.ref.id)))
    return focusConflict();
  return ok({ date: date.value, carryTo: carryTo.value, actions, occurrences, nextFocus });
}

/* ───────────────────────── Command ───────────────────────── */

interface PreparedAction extends ParsedActionItem {
  /** The Action's active placement, read before the command (its revision is expected). */
  readonly placement: CanonicalRecordState | null;
  /** The Action's planned block, read before the command (its revision is expected). */
  readonly block: CanonicalRecordState | null;
}

/** Everything End Day reads before its command opens. */
export interface PreparedEndDay {
  readonly parsed: ParsedEndDayInput;
  /** Every record the command may update, at the revision read here (duplicates allowed). */
  readonly expected: readonly ExpectedRevision[];
  readonly actions: readonly PreparedAction[];
  /** The ended day's focus, to confirm an Action listed only through it (never changed here). */
  readonly dayFocus: readonly DayFocusRow[];
  /** The carry date's focus when the input chooses it; null leaves that focus unchanged. */
  readonly carryFocus: DayFocusRecords | null;
}

/** What End Day changes inside its command, with the per-record event types. */
export interface EndDayMutationPlan {
  readonly mutations: readonly CanonicalMutation[];
  /** Created placements, focus selections, and materialized occurrences, for grouped undo. */
  readonly created: readonly CreatedRecord[];
  readonly eventTypeFor: (mutation: CanonicalMutation) => string | undefined;
}

async function activePlacement(
  kit: TodayKit,
  ownerId: OwnerId,
  actionId: UUID,
): Promise<CanonicalRecordState | null> {
  const record = await kit.queries.getActivePlacement(ownerId, 'action', actionId);
  if (record === null) return null;
  const document = record.document as PlanningPlacementDocument;
  return document.archivedAt === undefined && placementTargetId(document.target) === actionId
    ? record
    : null;
}

/**
 * Pre-reads outside the transaction supply every expected revision: each chosen Action with its
 * active placement and planned block, materialized occurrence revisions, the ended day's focus,
 * and the carry date's focus. An Action that no longer exists is `entity_not_found`.
 */
export async function prepareEndDay(
  kit: TodayKit,
  session: TodaySession,
  parsed: ParsedEndDayInput,
): Promise<ApplicationResult<PreparedEndDay>> {
  const { ownerId, profile } = session;
  const { date, carryTo, actions, occurrences, nextFocus } = parsed;
  const expected: ExpectedRevision[] = [];
  const prepared: PreparedAction[] = [];
  for (const item of actions) {
    if ((await kit.queries.readRecord(ownerId, item.ref)) === null) return missing(item.ref);
    const placement = await activePlacement(kit, ownerId, item.ref.id);
    const block = await kit.queries.getPlannedActionBlock(ownerId, item.ref.id);
    expected.push(
      { ref: item.ref, revision: item.revision },
      ...expectedOf(placement),
      ...expectedOf(block),
    );
    prepared.push({ ...item, placement, block });
  }
  for (const item of occurrences) {
    const revision = item.occurrence.revision;
    if (revision !== undefined) expected.push({ ref: item.ref, revision });
  }
  const dayFocus =
    actions.length === 0 ? [] : await kit.queries.listDayFocus(ownerId, profile.profileId, date);
  const carryFocus =
    nextFocus === undefined ? null : await readDayFocus(kit, ownerId, profile.profileId, carryTo);
  if (carryFocus !== null) expected.push(...carryFocus.expected);
  return { ok: true, value: { parsed, expected, actions: prepared, dayFocus, carryFocus } };
}

/**
 * End Day inside the command transaction: every chosen Action, placement, block, and occurrence is
 * read again and checked against the day, changed through the End Day decision table
 * (`planEndDayAction`), and the carry date's focus goes through the shared focus planner.
 */
export async function planEndDayMutations(
  kit: TodayKit,
  session: TodaySession,
  prepared: PreparedEndDay,
  records: PlanningRecordReader,
  context: CommandContext,
): Promise<DomainResult<EndDayMutationPlan>> {
  const { ownerId, profile } = session;
  const { date, carryTo, occurrences, nextFocus } = prepared.parsed;
  const bounds = localDayBounds(date, profile.planningTimeZone);

  /** The Action is in the day's focus: an active day focus selection of this profile and date. */
  const inDayFocus = async (actionId: UUID): Promise<boolean> => {
    for (const row of prepared.dayFocus) {
      if (row.target.kind !== 'action' || row.target.action.id !== actionId) continue;
      const record = await records.read(createEntityRef('focus_selection', row.id, ownerId));
      const document = record?.document as FocusSelectionDocument | undefined;
      if (
        document?.kind === 'day_focus' &&
        document.archivedAt === undefined &&
        document.profileId === profile.profileId &&
        document.periodStart === date &&
        document.target.kind === 'action' &&
        document.target.actionId === actionId
      )
        return true;
    }
    return false;
  };

  const mutations: CanonicalMutation[] = [];
  const created: CreatedRecord[] = [];
  const types = eventTypesByRecord();
  const add = (mutation: CanonicalMutation, eventType: string | undefined): void => {
    mutations.push(mutation);
    if (eventType !== undefined) types.set(mutation, eventType);
  };

  for (const item of prepared.actions) {
    const current = await records.read(item.ref);
    if (current === null) return changed('action_missing');
    const action = current.document as ActionCanonicalDocument;

    let placedOnDay = false;
    if (item.placement !== null) {
      const placement = await records.read(item.placement.ref);
      const document = placement?.document as PlanningPlacementDocument | undefined;
      if (
        document === undefined ||
        document.archivedAt !== undefined ||
        placementTargetId(document.target) !== item.ref.id
      )
        return changed('placement_changed');
      placedOnDay = document.period.kind === 'day' && document.period.date === date;
    }

    let block: CanonicalRecordState | null = null;
    let plannedBlock: 'none' | 'on_day' | 'elsewhere' = 'none';
    if (item.block !== null) {
      block = await records.read(item.block.ref);
      const document = block?.document as TimeBlockDocument | undefined;
      if (
        document === undefined ||
        !isCurrentPlanned(document) ||
        document.target.kind !== 'action' ||
        document.target.actionId !== item.ref.id
      )
        return changed('block_changed');
      plannedBlock = intervalsIntersect(document, bounds) ? 'on_day' : 'elsewhere';
    }

    if (!placedOnDay && plannedBlock !== 'on_day' && !(await inDayFocus(item.ref.id)))
      return actionNotOnDay();

    const outcome = planEndDayAction({ state: action.state, plannedBlock }, item.decision.kind);
    if (!outcome.ok) return outcome;
    const { actionState, blockState, movesPlacement } = outcome.value;

    if (actionState !== undefined && actionState !== action.state) {
      const next = actionWithState(action, actionState, context.now);
      if (!next.ok) return next;
      add(updateFrom(current, next.value), endDayEventTypes.action[item.decision.kind]);
    }
    if (blockState !== undefined) {
      if (block === null) return changed('block_changed');
      const valid = validateTimeBlockTransition(timeBlockSnapshot(block, context.now), blockState);
      if (!valid.ok) return valid;
      add(
        updateFrom(block, { ...(block.document as TimeBlockDocument), state: blockState }),
        endDayEventTypes.block[blockState],
      );
    }
    if (movesPlacement) {
      const period =
        item.decision.kind === 'move' ? item.decision.period : createDayPeriod(carryTo);
      const placed = await upsertPlacement(
        records,
        ownerId,
        item.placement,
        placementTarget('action', item.ref.id),
        period,
        kit.nextId,
      );
      if (!placed.ok) return placed;
      if (placed.value.mutation !== null) add(placed.value.mutation, endDayEventTypes.placement);
      if (placed.value.created !== undefined) created.push(placed.value.created);
    }
  }

  for (const item of occurrences) {
    const opened = await openOccurrence(records, ownerId, item.occurrence);
    if (!opened.ok) return opened;
    const { document } = opened.value;
    if (document.period.kind !== 'date' || !isOccurrenceOnDate(document, date))
      return occurrenceNotOnDay();
    const progress =
      item.decision === 'complete'
        ? completeOccurrenceProgress(opened.value.progress, { confirmExtra: false })
        : skipOccurrenceProgress(opened.value.progress);
    if (!progress.ok) return progress;
    const next = validateOccurrenceDocument(
      opened.value.ref,
      withProgress(document, progress.value, context.now),
      context.now,
    );
    if (!next.ok) return next;
    const type = endDayEventTypes.occurrence[item.decision];
    if (opened.value.record === null) {
      add(createMutation(opened.value.ref, next.value), type);
      created.push({ ref: opened.value.ref, kind: 'routine_occurrence' });
    } else {
      add(updateFrom(opened.value.record, next.value), type);
    }
  }

  if (nextFocus !== undefined && prepared.carryFocus !== null) {
    const plan = await planFocusMutations(
      records,
      {
        ownerId,
        profileId: profile.profileId,
        date: carryTo,
        existing: prepared.carryFocus.records,
        desired: nextFocus,
      },
      kit.nextId,
      context,
    );
    if (!plan.ok) return plan;
    for (const mutation of plan.value.mutations) add(mutation, plan.value.eventTypeFor(mutation));
    created.push(...plan.value.created);
  }

  return ok({ mutations, created, eventTypeFor: types.eventTypeFor });
}

async function applyEndDay(
  kit: TodayKit,
  input: EndDayInput,
  commandId: CommandId | undefined,
): Promise<ApplicationResult<CommandReceipt>> {
  const session = await kit.session();
  const parsed = parseEndDayInput(input, session);
  if (!parsed.ok) return rejected(parsed.error);
  const { actions, occurrences, nextFocus } = parsed.value;
  if (actions.length === 0 && occurrences.length === 0 && nextFocus === undefined) {
    const nothing = noChange();
    if (!nothing.ok) return rejected(nothing.error);
  }
  // Pre-reads outside the transaction supply every expected revision.
  const prepared = await prepareEndDay(kit, session, parsed.value);
  if (!prepared.ok) return prepared;
  return kit.run(
    session.ownerId,
    commandId,
    endDayEventType,
    prepared.value.expected,
    ({ records, context }) => planEndDayMutations(kit, session, prepared.value, records, context),
  );
}
