/**
 * Review reminder definitions for Time Blocks and timed Routines: read, set or replace,
 * turn off, and the steps a block move and a Routine archive share. Every write is one
 * `executeCommand` with expected revisions, a `reminder.set` or `reminder.canceled` event carrying
 * `{ operation }` only, a receipt, and a grouped `planning.restore_v1` undo.
 *
 * A target keeps one reminder record: setting a reminder that was turned off schedules the same
 * record again (the Reminder state machine's explicit `canceled -> scheduled`), so an older undo can
 * never schedule a second one. Nothing here asks for notification permission, schedules anything, or
 * delivers a notification; the notification application owns those effects.
 */
import {
  addDays,
  checkRoutineAcceptsReminder,
  checkTimeBlockAcceptsReminder,
  createEntityRef,
  currentPlanningDate,
  err,
  followTimeBlockStart,
  formatInstantInZone,
  ok,
  parseRoutineReminderRequest,
  parseTimeBlockReminderRequest,
  parseUUID,
  projectRoutineOccurrences,
  reminderMinutesBefore,
  resolveNextRoutineReminder,
  resolveTimeBlockReminder,
  scheduleReminderState,
  turnOffReminderState,
  type CalendarDate,
  type DomainResult,
  type IanaTimeZone,
  type Instant,
  type MaterializedOccurrenceSnapshot,
  type OwnerId,
  type ReminderSchedule,
  type UUID,
} from '@yelaxis/domain';

import { noChange } from './alignment-kit';
import type { CanonicalMutation, CanonicalRecordState, ExpectedRevision } from './contracts';
import type { ReminderMethods } from './planning';
import type {
  PlanningApplication,
  PlanningQueryPort,
  PlanningReminderDocument,
  ReminderView,
  RoutineDocument,
  TimeBlockDocument,
} from './planning-contracts';
import { createMutation, updateFrom, type CreatedRecord } from './planning-kit';
import {
  createSchedulingKit,
  invalid,
  rejected,
  type SchedulingKit,
} from './planning-scheduling-support';
import { routineSnapshot } from './planning-timed-items';
import type { ApplicationDependencies, PlanningRecordReader } from './ports';

/** Event types of reminder records (payloads carry `{ operation }` only). */
export const reminderEventTypes = Object.freeze({
  set: 'reminder.set',
  canceled: 'reminder.canceled',
});

/** The one id field a reminder document names its Review target with. */
export type ReminderTargetField =
  { readonly timeBlockId: UUID } | { readonly routineId: UUID } | { readonly reviewId: UUID };

/* ───────────────────────── Errors ───────────────────────── */

const malformed = (): DomainResult<never> =>
  invalid('reminder_input', 'This reminder request is not valid. Refresh and try again.');

/** The reminder (or its target) changed since the person saw it. */
export const reminderChanged = (): DomainResult<never> =>
  invalid('reminder_changed', 'This reminder changed. Review it and try again.');

const alreadyOff = (): DomainResult<never> =>
  err({
    code: 'invalid_transition',
    message: 'This reminder is already off.',
    details: { reason: 'reminder_not_scheduled' },
  });

/* ───────────────────────── Records and views ───────────────────────── */

export const reminderDocumentOf = (record: CanonicalRecordState): PlanningReminderDocument =>
  record.document as unknown as PlanningReminderDocument;

/** Only a scheduled reminder is shown, carried, replaced, or turned off. */
export const isScheduledReminder = (
  record: CanonicalRecordState | null,
): record is CanonicalRecordState =>
  record !== null && reminderDocumentOf(record).state === 'scheduled';

function localReading(schedule: ReminderSchedule): ReturnType<typeof formatInstantInZone> {
  try {
    return formatInstantInZone(schedule.remindAt, schedule.timeZone);
  } catch {
    // A stored zone the runtime cannot read is shown in UTC rather than failing the page.
    return formatInstantInZone(schedule.remindAt, 'UTC' as IanaTimeZone);
  }
}

/** The view of a scheduled reminder; `undefined` when there is none or it is off. */
export function reminderView(record: CanonicalRecordState | null): ReminderView | undefined {
  if (!isScheduledReminder(record)) return undefined;
  const { schedule } = reminderDocumentOf(record);
  const local = localReading(schedule);
  const minutesBefore = reminderMinutesBefore(schedule);
  return {
    reminderId: record.ref.id,
    localRevision: record.localRevision,
    kind: schedule.kind,
    remindAt: schedule.remindAt,
    timeZone: schedule.timeZone,
    date: local.date,
    time: local.time,
    ...(minutesBefore === undefined ? {} : { minutesBefore }),
  };
}

const targetsOf = (document: PlanningReminderDocument): Readonly<Record<string, unknown>> =>
  document;

const sameSchedule = (left: ReminderSchedule, right: ReminderSchedule): boolean =>
  left.kind === right.kind &&
  left.remindAt === right.remindAt &&
  left.timeZone === right.timeZone &&
  (left.kind === 'at' || (right.kind === 'relative' && left.offsetMinutes === right.offsetMinutes));

function sameTarget(document: PlanningReminderDocument, target: ReminderTargetField): boolean {
  const entries = Object.entries(target);
  return (
    entries.length === 1 &&
    entries.every(([key, id]) => targetsOf(document)[key] === id) &&
    ['actionId', 'timeBlockId', 'routineId', 'reviewId'].filter(
      (key) => targetsOf(document)[key] !== undefined,
    ).length === 1
  );
}

/* ───────────────────────── Untrusted command input ───────────────────────── */

type Fields = Readonly<Record<string, unknown>>;

/** A plain object with every required key and no key outside `required` and `optional`. */
function inputFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Fields | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const fields = value as Fields;
  if (!required.every((key) => Object.hasOwn(fields, key))) return null;
  return Object.keys(fields).every((key) => required.includes(key) || optional.includes(key))
    ? fields
    : null;
}

const isRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

function targetId(value: unknown): DomainResult<UUID> {
  if (typeof value !== 'string') return malformed();
  const parsed = parseUUID(value);
  return parsed.ok ? parsed : malformed();
}

/** A set-or-replace request: target id, the target's revision, the shown reminder's revision. */
export interface SetReminderInput<Request> {
  readonly targetId: UUID;
  readonly revision: number;
  /** Absent when the person saw no reminder on the target. */
  readonly reminderRevision?: number;
  readonly request: Request;
}

export function parseSetReminderInput<Request>(
  value: unknown,
  idKey: string,
  parseRequest: (value: unknown) => DomainResult<Request>,
): DomainResult<SetReminderInput<Request>> {
  const input = inputFields(value, [idKey, 'revision', 'reminder'], ['reminderRevision']);
  if (input === null) return malformed();
  const id = targetId(input[idKey]);
  if (!id.ok) return id;
  const revision = input['revision'];
  const reminderRevision = input['reminderRevision'];
  if (!isRevision(revision) || (reminderRevision !== undefined && !isRevision(reminderRevision)))
    return malformed();
  const request = parseRequest(input['reminder']);
  if (!request.ok) return request;
  return ok({
    targetId: id.value,
    revision,
    ...(reminderRevision === undefined ? {} : { reminderRevision }),
    request: request.value,
  });
}

export function parseTurnOffReminderInput(
  value: unknown,
  idKey: string,
): DomainResult<{ readonly targetId: UUID; readonly reminderRevision: number }> {
  const input = inputFields(value, [idKey, 'reminderRevision']);
  if (input === null) return malformed();
  const id = targetId(input[idKey]);
  if (!id.ok) return id;
  const reminderRevision = input['reminderRevision'];
  if (!isRevision(reminderRevision)) return malformed();
  return ok({ targetId: id.value, reminderRevision });
}

/* ───────────────────────── Planning steps shared with reviews ───────────────────────── */

/**
 * A reminder command read before it opens: the revisions it expects and the check that depends on
 * what was read. The check is returned inside the command, after the command-id receipt lookup, so a
 * repeated command id returns its receipt and a refused command writes nothing.
 */
export interface ReminderPreparation<Value> {
  readonly expected: readonly ExpectedRevision[];
  readonly check: DomainResult<Value>;
}

/**
 * Setting a target's reminder: the person must have seen the reminder the target has now, so
 * `reminderRevision` is given exactly when one is scheduled (it is replaced at that revision). A
 * reminder that is off is set again at its current revision.
 */
export function prepareSetReminder(
  current: CanonicalRecordState | null,
  reminderRevision: number | undefined,
): ReminderPreparation<true> {
  if (isScheduledReminder(current) !== (reminderRevision !== undefined))
    return { expected: [], check: reminderChanged() };
  return {
    expected:
      current === null
        ? []
        : [{ ref: current.ref, revision: reminderRevision ?? current.localRevision }],
    check: ok(true),
  };
}

/** Turning a target's reminder off: its scheduled reminder at the shown revision, else "already off". */
export function prepareTurnOffReminder(
  current: CanonicalRecordState | null,
  reminderRevision: number,
): ReminderPreparation<CanonicalRecordState> {
  return isScheduledReminder(current)
    ? { expected: [{ ref: current.ref, revision: reminderRevision }], check: ok(current) }
    : { expected: [], check: alreadyOff() };
}

/** A target that no longer exists (checked inside the command). */
export const reminderTargetMissing = (): DomainResult<never> =>
  invalid('reminder_target_missing', 'This item is no longer available.');

export interface ReminderPlan {
  readonly mutations: readonly CanonicalMutation[];
  readonly created: readonly CreatedRecord[];
}

/**
 * Inside the command: create the target's reminder, or schedule its existing record with the new
 * time (replacing a scheduled one or setting one that was turned off again).
 */
export async function planSetReminder(input: {
  readonly records: PlanningRecordReader;
  readonly ownerId: OwnerId;
  readonly current: CanonicalRecordState | null;
  readonly target: ReminderTargetField;
  readonly schedule: ReminderSchedule;
  readonly nextId: () => UUID;
}): Promise<DomainResult<ReminderPlan>> {
  const next = { ...input.target, schedule: input.schedule, state: 'scheduled' as const };
  if (input.current === null) {
    const ref = createEntityRef('reminder', input.nextId(), input.ownerId);
    return ok({ mutations: [createMutation(ref, next)], created: [{ ref, kind: 'reminder' }] });
  }
  const record = await input.records.read(input.current.ref);
  if (record === null) return reminderChanged();
  const document = reminderDocumentOf(record);
  if (!sameTarget(document, input.target)) return reminderChanged();
  const state = scheduleReminderState(document.state);
  if (!state.ok) return state;
  if (document.state === 'scheduled' && sameSchedule(document.schedule, input.schedule))
    return noChange();
  return ok({ mutations: [updateFrom(record, next)], created: [] });
}

/** Inside the command: turn the target's scheduled reminder off (`scheduled -> canceled`). */
export async function planTurnOffReminder(
  records: PlanningRecordReader,
  current: CanonicalRecordState,
  target: ReminderTargetField,
): Promise<DomainResult<ReminderPlan>> {
  const record = await records.read(current.ref);
  if (record === null) return reminderChanged();
  const document = reminderDocumentOf(record);
  if (!sameTarget(document, target)) return reminderChanged();
  const state = turnOffReminderState(document.state);
  if (!state.ok) return state;
  return ok({ mutations: [updateFrom(record, { ...document, state: state.value })], created: [] });
}

/* ───────────────────────── Time Block moves (superseding blocks) ───────────────────────── */

/**
 * The block's scheduled reminder, read before a command that supersedes the block, so its revision
 * can be expected; null when the block has none (a reminder that is off stays with the old block).
 */
export async function readCarriedBlockReminder(
  queries: Pick<PlanningQueryPort, 'getTargetReminder'>,
  ownerId: OwnerId,
  blockId: UUID,
): Promise<CanonicalRecordState | null> {
  const record = await queries.getTargetReminder(ownerId, { kind: 'time_block', id: blockId });
  return isScheduledReminder(record) ? record : null;
}

/**
 * Inside the command that supersedes `fromBlockId`: the reminder follows the replacement block. A
 * relative reminder is resolved again from the new start; a reminder at a chosen time stays. The
 * update comes after the replacement block is created.
 */
export async function carryBlockReminder(
  records: PlanningRecordReader,
  carried: CanonicalRecordState | null,
  fromBlockId: UUID,
  replacement: { readonly id: UUID; readonly startsAt: Instant },
): Promise<DomainResult<CanonicalMutation | null>> {
  if (carried === null) return ok(null);
  const record = await records.read(carried.ref);
  if (record === null) return reminderChanged();
  const document = reminderDocumentOf(record);
  if (!sameTarget(document, { timeBlockId: fromBlockId }) || document.state !== 'scheduled')
    return reminderChanged();
  return ok(
    updateFrom(record, {
      timeBlockId: replacement.id,
      schedule: followTimeBlockStart(document.schedule, replacement.startsAt),
      state: 'scheduled',
    }),
  );
}

/* ───────────────────────── Routines ───────────────────────── */

/**
 * Days of occurrences a Routine reminder reads first: daily, weekly, and most monthly rules repeat
 * within a year (at most every 365 days, 52 weeks, or 12 months).
 */
const routineReminderLookaheadDays = 400;

/**
 * Days it reads at most, only when the first ones hold no occurrence: every twelve months on the
 * 29th, skipping months without one, happens only on 29 February, every four years (eight across
 * 2100), and its reminder may come up to seven days before.
 */
const routineReminderFurthestDays = 2_940;

/**
 * The occurrence dates a Routine reminder reads: from two days before planning today, or before the
 * Routine's first start when that is later, through `lookaheadDays` (by default the furthest, which
 * the materialized occurrences are read for). A fixed-zone Routine may be up to 26 hours behind the
 * planning zone, so an occurrence still ahead can be two dates earlier there.
 */
export function routineReminderWindow(
  today: CalendarDate,
  document: RoutineDocument,
  lookaheadDays = routineReminderFurthestDays,
): { readonly start: CalendarDate; readonly end: CalendarDate } {
  // Generations are ordered by start, so the first one starts the Routine.
  const first = document.generations[0]?.rule.startsOn;
  const from = first !== undefined && first > today ? first : today;
  return { start: addDays(from, -2), end: addDays(from, lookaheadDays) };
}

/**
 * The schedule of a Routine reminder: only an active Routine whose current pattern is at a set time
 * accepts one, and it is resolved `minutesBefore` before the next occurrence whose reminder is
 * still ahead, with the offset later occurrences are resolved from.
 */
export function routineReminderSchedule(input: {
  readonly routineId: UUID;
  readonly document: RoutineDocument;
  readonly materialized: readonly MaterializedOccurrenceSnapshot[];
  readonly planningTimeZone: IanaTimeZone;
  readonly now: Instant;
  readonly minutesBefore: number;
}): DomainResult<ReminderSchedule> {
  const current = input.document.generations.at(-1);
  if (current === undefined) return invalid('routine_generations', 'A Routine needs a schedule.');
  const accepts = checkRoutineAcceptsReminder({
    state: input.document.state,
    schedulingMode: current.schedulingMode,
  });
  if (!accepts.ok) return accepts;
  const today = currentPlanningDate({ now: () => input.now }, input.planningTimeZone);
  const resolveWithin = (lookaheadDays?: number): DomainResult<ReminderSchedule> => {
    const projected = projectRoutineOccurrences({
      series: routineSnapshot({ id: input.routineId, document: input.document }),
      materialized: input.materialized,
      window: routineReminderWindow(today, input.document, lookaheadDays),
      planningTimeZone: input.planningTimeZone,
    });
    if (!projected.ok) return projected;
    return resolveNextRoutineReminder({
      occurrences: projected.value,
      now: input.now,
      minutesBefore: input.minutesBefore,
    });
  };
  // The first year almost always holds the next occurrence; only a Routine with none there (one
  // on 29 February, or one that has ended) is read further.
  const firstYear = resolveWithin(routineReminderLookaheadDays);
  return !firstYear.ok && firstYear.error.details?.['reason'] === 'reminder_no_upcoming_occurrence'
    ? resolveWithin()
    : firstYear;
}

/** The Routine's scheduled reminder, read before an archive so its revision can be expected. */
export async function readRoutineReminder(
  queries: Pick<PlanningQueryPort, 'getTargetReminder'>,
  ownerId: OwnerId,
  routineId: UUID,
): Promise<CanonicalRecordState | null> {
  const record = await queries.getTargetReminder(ownerId, { kind: 'routine', id: routineId });
  return isScheduledReminder(record) ? record : null;
}

/** Inside the archive: the stated sub-operation that turns the Routine's reminder off. */
export async function cancelRoutineReminder(
  records: PlanningRecordReader,
  reminder: CanonicalRecordState | null,
  routineId: UUID,
): Promise<
  DomainResult<{
    readonly mutation: CanonicalMutation;
    readonly prior: CanonicalRecordState;
  } | null>
> {
  if (reminder === null) return ok(null);
  const record = await records.read(reminder.ref);
  if (record === null) return reminderChanged();
  const planned = await planTurnOffReminder(records, record, { routineId });
  if (!planned.ok) return planned;
  const [mutation] = planned.value.mutations;
  return mutation === undefined ? ok(null) : ok({ mutation, prior: record });
}

/* ───────────────────────── Facade methods ───────────────────────── */

async function setBlockReminder(
  kit: SchedulingKit,
  raw: Parameters<PlanningApplication['setTimeBlockReminder']>[0],
  commandId: Parameters<PlanningApplication['setTimeBlockReminder']>[1],
): ReturnType<PlanningApplication['setTimeBlockReminder']> {
  const input = parseSetReminderInput(raw, 'blockId', parseTimeBlockReminderRequest);
  if (!input.ok) return rejected(input.error);
  const { ownerId, profile } = await kit.session();
  const blockRef = createEntityRef('time_block', input.value.targetId, ownerId);
  const current = await kit.queries.getTargetReminder(ownerId, {
    kind: 'time_block',
    id: blockRef.id,
  });
  const prepared = prepareSetReminder(current, input.value.reminderRevision);
  // The block's expected revision also refuses a block that does not exist (`entity_not_found`).
  return kit.run(
    ownerId,
    commandId,
    reminderEventTypes.set,
    [{ ref: blockRef, revision: input.value.revision }, ...prepared.expected],
    async ({ records }) => {
      if (!prepared.check.ok) return prepared.check;
      const block = await records.read(blockRef);
      if (block === null) return reminderChanged();
      const document = block.document as TimeBlockDocument;
      const accepts = checkTimeBlockAcceptsReminder(document);
      if (!accepts.ok) return accepts;
      const schedule = resolveTimeBlockReminder(input.value.request, {
        blockStart: document.startsAt,
        timeZone: profile.planningTimeZone,
      });
      if (!schedule.ok) return schedule;
      return planSetReminder({
        records,
        ownerId,
        current,
        target: { timeBlockId: blockRef.id },
        schedule: schedule.value,
        nextId: kit.nextId,
      });
    },
  );
}

async function setRoutineReminder(
  kit: SchedulingKit,
  dependencies: ApplicationDependencies,
  raw: Parameters<PlanningApplication['setRoutineReminder']>[0],
  commandId: Parameters<PlanningApplication['setRoutineReminder']>[1],
): ReturnType<PlanningApplication['setRoutineReminder']> {
  const input = parseSetReminderInput(raw, 'routineId', parseRoutineReminderRequest);
  if (!input.ok) return rejected(input.error);
  const { ownerId, profile } = await kit.session();
  const routineRef = createEntityRef('routine', input.value.targetId, ownerId);
  const routine = await kit.queries.readRecord(ownerId, routineRef);
  const current = await kit.queries.getTargetReminder(ownerId, {
    kind: 'routine',
    id: routineRef.id,
  });
  const prepared = prepareSetReminder(current, input.value.reminderRevision);
  // Read before the command; the expected Routine revision keeps the document they belong to (and
  // refuses a Routine that does not exist).
  const today = currentPlanningDate(dependencies.clock, profile.planningTimeZone);
  const materialized =
    routine === null
      ? []
      : await kit.queries.listMaterializedOccurrences(
          ownerId,
          routineReminderWindow(today, routine.document as RoutineDocument),
          routineRef.id,
        );
  return kit.run(
    ownerId,
    commandId,
    reminderEventTypes.set,
    [{ ref: routineRef, revision: input.value.revision }, ...prepared.expected],
    async ({ records, context }) => {
      if (!prepared.check.ok) return prepared.check;
      const stored = await records.read(routineRef);
      if (stored === null) return reminderChanged();
      const schedule = routineReminderSchedule({
        routineId: routineRef.id,
        document: stored.document as RoutineDocument,
        materialized,
        planningTimeZone: profile.planningTimeZone,
        now: context.now,
        minutesBefore: input.value.request.minutesBefore,
      });
      if (!schedule.ok) return schedule;
      return planSetReminder({
        records,
        ownerId,
        current,
        target: { routineId: routineRef.id },
        schedule: schedule.value,
        nextId: kit.nextId,
      });
    },
  );
}

async function turnOff(
  kit: SchedulingKit,
  raw: unknown,
  kind: 'time_block' | 'routine',
  commandId: Parameters<PlanningApplication['turnOffRoutineReminder']>[1],
): ReturnType<PlanningApplication['turnOffRoutineReminder']> {
  const input = parseTurnOffReminderInput(raw, kind === 'time_block' ? 'blockId' : 'routineId');
  if (!input.ok) return rejected(input.error);
  const ownerId = await kit.ownerId();
  const targetRef = createEntityRef(kind, input.value.targetId, ownerId);
  const current = await kit.queries.getTargetReminder(ownerId, { kind, id: targetRef.id });
  const prepared = prepareTurnOffReminder(current, input.value.reminderRevision);
  const target: ReminderTargetField =
    kind === 'time_block' ? { timeBlockId: targetRef.id } : { routineId: targetRef.id };
  return kit.run(
    ownerId,
    commandId,
    reminderEventTypes.canceled,
    prepared.expected,
    async ({ records }) => {
      if ((await records.read(targetRef)) === null) return reminderTargetMissing();
      if (!prepared.check.ok) return prepared.check;
      return planTurnOffReminder(records, prepared.check.value, target);
    },
  );
}

/**
 * The reminder facade methods. `getRoutine` adds the Routine's scheduled reminder to the projected
 * detail, so it replaces the projection's own `getRoutine`.
 */
export function createReminderMethods(
  dependencies: ApplicationDependencies,
  queries: PlanningQueryPort,
  projections: Pick<PlanningApplication, 'getRoutine'>,
): ReminderMethods {
  const kit = createSchedulingKit(dependencies, queries);
  return {
    async getRoutine(routineId) {
      const detail = await projections.getRoutine(routineId);
      if (detail === null) return null;
      const ownerId = await kit.ownerId();
      const reminder = reminderView(
        await queries.getTargetReminder(ownerId, { kind: 'routine', id: detail.routine.id }),
      );
      return reminder === undefined ? detail : { ...detail, reminder };
    },
    async getTimeBlockReminder(blockId) {
      const id = typeof blockId === 'string' ? parseUUID(blockId) : null;
      if (id === null || !id.ok) return null;
      const ownerId = await kit.ownerId();
      return (
        reminderView(
          await queries.getTargetReminder(ownerId, { kind: 'time_block', id: id.value }),
        ) ?? null
      );
    },
    setTimeBlockReminder: (input, commandId) => setBlockReminder(kit, input, commandId),
    turnOffTimeBlockReminder: (input, commandId) => turnOff(kit, input, 'time_block', commandId),
    setRoutineReminder: (input, commandId) =>
      setRoutineReminder(kit, dependencies, input, commandId),
    turnOffRoutineReminder: (input, commandId) => turnOff(kit, input, 'routine', commandId),
  };
}
