/**
 * Today and Focus Part 2 — a day's focus and Focus mode. Reads offer focus choices in
 * plan order and one Action for Focus mode; commands add, remove, reorder, or replace a date's focus
 * (at most three). Each command is one `executeCommand` transaction with expected revisions,
 * minimized `{ operation }` events with per-record `focus.*` types, a receipt, an outbox group when
 * sync is on, and a grouped `planning.restore_v1` undo. Focus never changes its target's state,
 * placement, block, priority, or order anywhere else, and nothing is ranked or preselected.
 *
 * Every check that can fail after a first successful run (for example "already in focus" on a
 * retry) is returned from inside the command, so a repeated command id gets its stored receipt.
 */
import {
  appendDayFocus,
  compareOrder,
  createEntityRef,
  err,
  isActionOverdue,
  isFocusableActionState,
  ok,
  parseCalendarDate,
  parseUUID,
  reorderWithin,
  validateFocusDate,
  type CalendarDate,
  type CommandContext,
  type DomainResult,
  type EntityRef,
  type OrderKeyChange,
  type OwnerId,
} from '@yelaxis/domain';

import type { CanonicalMutation, CanonicalRecordState, ExpectedRevision } from './contracts';
import type { FocusSelectionDocument } from './planning-contracts';
import { updateFrom } from './planning-kit';
import { changed, invalid } from './planning-scheduling-support';
import type { PlanningRecordReader } from './ports';
import type {
  DayFocusRow,
  FocusSessionView,
  FocusTargetInput,
  TodayFocusMethods,
} from './today-contracts';
import { focusRowTarget, loadDay, loadFocusChoices } from './today-day';
import {
  focusEventTypes,
  parseFocusTarget,
  planFocusMutations,
  prepareDayFocusChange,
  readDayFocus,
  type DayFocusRecords,
} from './today-focus-plan';
import {
  requireTodayDate,
  type TodayCommandPlan,
  type TodayKit,
  type TodaySession,
} from './today-kit';

/** Command event type of `setDayFocus`; every changed record carries its own `focus.*` type. */
export const focusSetEventType = 'focus.set';

/* ───────────────────────── Input checks ───────────────────────── */

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A command date: a canonical calendar date. */
function commandDate(value: unknown): DomainResult<CalendarDate> {
  const parsed = parseCalendarDate(typeof value === 'string' ? value : '');
  return parsed.ok ? parsed : invalid('date', 'Choose a valid date.');
}

/** A revision the person's view read: a positive safe integer. */
function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function notDayFocus(): DomainResult<never> {
  return err({
    code: 'invalid_value',
    message: "This is no longer in the day's focus.",
    details: { reason: 'not_day_focus' },
  });
}

function selectionRef(ownerId: OwnerId, id: unknown): DomainResult<EntityRef<'focus_selection'>> {
  const parsed = parseUUID(typeof id === 'string' ? id : '');
  return parsed.ok ? ok(createEntityRef('focus_selection', parsed.value, ownerId)) : notDayFocus();
}

/**
 * An active day focus selection of this profile that can still change: its date is today or later
 * (an earlier day's focus is read-only history, including removal).
 */
function editableSelection(
  record: CanonicalRecordState,
  session: TodaySession,
): DomainResult<FocusSelectionDocument> {
  const document = record.document as FocusSelectionDocument;
  if (
    document.kind !== 'day_focus' ||
    document.archivedAt !== undefined ||
    document.profileId !== session.profile.profileId
  )
    return notDayFocus();
  const date = validateFocusDate(document.periodStart, session.today);
  return date.ok ? ok(document) : date;
}

/** A pre-read that could not read a listed row: the day's focus is changing. */
function completeRead(current: DayFocusRecords): DomainResult<DayFocusRecords> {
  return current.records.length === current.rows.length ? ok(current) : changed('focus_changed');
}

/* ───────────────────────── Planning helpers ───────────────────────── */

/** No focus rows: the pre-read of a selection that does not exist (the command reports it). */
const emptyFocus: DayFocusRecords = Object.freeze({
  rows: [],
  records: [],
  expected: [],
  items: [],
});

/** Plan a date's complete chosen focus inside the transaction (shared rules, see planFocusMutations). */
async function plannedFocus(
  kit: TodayKit,
  records: PlanningRecordReader,
  context: CommandContext,
  session: TodaySession,
  date: CalendarDate,
  existing: readonly CanonicalRecordState[],
  desired: readonly FocusTargetInput[],
): Promise<DomainResult<TodayCommandPlan>> {
  const plan = await planFocusMutations(
    records,
    {
      ownerId: session.ownerId,
      profileId: session.profile.profileId,
      date,
      existing,
      desired,
    },
    kit.nextId,
    context,
  );
  if (!plan.ok) return plan;
  return ok({
    mutations: plan.value.mutations,
    created: plan.value.created,
    eventTypeFor: plan.value.eventTypeFor,
  });
}

interface PreparedDayFocus {
  readonly date: CalendarDate;
  readonly current: DayFocusRecords;
}

/** The date checks shared by `addFocus` and `setDayFocus`, then the date's current focus. */
async function prepareDayFocus(
  kit: TodayKit,
  session: TodaySession,
  value: unknown,
): Promise<DomainResult<PreparedDayFocus>> {
  const date = commandDate(value);
  if (!date.ok) return date;
  const current = await prepareDayFocusChange(
    kit,
    { ownerId: session.ownerId, profileId: session.profile.profileId, today: session.today },
    date.value,
  );
  return current.ok ? ok({ date: date.value, current: current.value }) : current;
}

/* ───────────────────────── Focus mode ───────────────────────── */

/**
 * The next unfinished focus Action after `index` in the person's own order, continuing from the
 * start of the list; Routine Occurrences and finished Actions are passed over.
 */
function nextFocusAction(
  rows: readonly DayFocusRow[],
  index: number,
): { readonly actionId: DayFocusRow['id']; readonly title: string } | undefined {
  const following = [...rows.slice(index + 1), ...rows.slice(0, index)];
  for (const row of following) {
    if (row.target.kind === 'action' && isFocusableActionState(row.target.action.state))
      return { actionId: row.target.action.id, title: row.target.action.title };
  }
  return undefined;
}

/* ───────────────────────── Methods ───────────────────────── */

export function createTodayFocus(kit: TodayKit): TodayFocusMethods {
  return {
    async getFocusChoices(date) {
      const day = requireTodayDate(date);
      const session = await kit.session();
      return loadFocusChoices(kit, session, await loadDay(kit, session, day));
    },

    async getFocusSession(actionId) {
      const id = parseUUID(typeof actionId === 'string' ? actionId : '');
      if (!id.ok) return null;
      const session = await kit.session();
      const { ownerId, profile, today } = session;
      const row = await kit.queries.getFocusAction(ownerId, id.value);
      if (row === null) return null;
      const { plannedBlock, ...action } = row;
      const focus = [...(await kit.queries.listDayFocus(ownerId, profile.profileId, today))].sort(
        compareOrder,
      );
      const index = focus.findIndex(
        (item) => item.target.kind === 'action' && item.target.action.id === action.id,
      );
      const selection = focus[index];
      const next = selection === undefined ? undefined : nextFocusAction(focus, index);
      const view: FocusSessionView = {
        profile,
        today,
        action,
        overdue: isActionOverdue(
          action.state,
          action.due,
          kit.dependencies.clock,
          profile.planningTimeZone,
        ),
        ...(plannedBlock === undefined ? {} : { plannedBlock }),
        ...(selection === undefined
          ? {}
          : {
              todayFocus: {
                selectionId: selection.id,
                position: index + 1,
                ...(next === undefined ? {} : { next }),
              },
            }),
      };
      return view;
    },

    async addFocus(input, commandId) {
      const session = await kit.session();
      const raw: unknown = input;
      const prepared: DomainResult<PreparedDayFocus & { readonly desired: FocusTargetInput[] }> =
        await (async () => {
          if (!isRecord(raw)) return invalid('focus_target');
          const target = parseFocusTarget(session.ownerId, input.target);
          if (!target.ok) return target;
          const day = await prepareDayFocus(kit, session, raw['date']);
          if (!day.ok) return day;
          const appended = appendDayFocus(day.value.current.items, target.value.key);
          if (!appended.ok) return appended;
          return ok({
            ...day.value,
            desired: [
              ...day.value.current.rows.map((row) => focusRowTarget(row).target),
              input.target,
            ],
          });
        })();
      return kit.run(
        session.ownerId,
        commandId,
        focusEventTypes.added,
        prepared.ok ? prepared.value.current.expected : [],
        ({ records, context }) => {
          if (!prepared.ok) return prepared;
          const { current, date, desired } = prepared.value;
          return plannedFocus(kit, records, context, session, date, current.records, desired);
        },
      );
    },

    async removeFocus(input, commandId) {
      const session = await kit.session();
      const raw: unknown = input;
      const checked: DomainResult<ExpectedRevision> = (() => {
        if (!isRecord(raw)) return notDayFocus();
        const ref = selectionRef(session.ownerId, raw['selectionId']);
        if (!ref.ok) return ref;
        const revision = raw['revision'];
        return isRevision(revision) ? ok({ ref: ref.value, revision }) : invalid('revision');
      })();
      return kit.run(
        session.ownerId,
        commandId,
        focusEventTypes.removed,
        checked.ok ? [checked.value] : [],
        async ({ records, context }) => {
          if (!checked.ok) return checked;
          const record = await records.read(checked.value.ref);
          if (record === null) return changed('focus_missing');
          const document = editableSelection(record, session);
          if (!document.ok) return document;
          return ok({
            mutations: [updateFrom(record, { ...document.value, archivedAt: context.now })],
          });
        },
      );
    },

    async reorderFocus(input, commandId) {
      const session = await kit.session();
      const raw: unknown = input;
      const target: DomainResult<ExpectedRevision> = (() => {
        if (!isRecord(raw)) return notDayFocus();
        const direction = raw['direction'];
        if (direction !== 'up' && direction !== 'down') return invalid('direction');
        const ref = selectionRef(session.ownerId, raw['selectionId']);
        if (!ref.ok) return ref;
        const revision = raw['revision'];
        return isRevision(revision) ? ok({ ref: ref.value, revision }) : invalid('revision');
      })();
      const prepared: DomainResult<{
        readonly date: CalendarDate;
        readonly current: DayFocusRecords;
        readonly changes: readonly OrderKeyChange[];
      }> = await (async () => {
        if (!target.ok) return target;
        // An unknown row is reported by the command itself (entity_not_found).
        const record = await kit.queries.readRecord(session.ownerId, target.value.ref);
        if (record === null) return ok({ date: session.today, current: emptyFocus, changes: [] });
        const document = editableSelection(record, session);
        if (!document.ok) return document;
        const date = document.value.periodStart;
        const current = completeRead(
          await readDayFocus(kit, session.ownerId, session.profile.profileId, date),
        );
        if (!current.ok) return current;
        const changes = reorderWithin(
          current.value.items,
          target.value.ref.id,
          input.direction,
          'spaced',
        );
        return changes.ok ? ok({ date, current: current.value, changes: changes.value }) : changes;
      })();
      const expected: ExpectedRevision[] = target.ok ? [target.value] : [];
      if (prepared.ok) {
        const byId = new Map<string, CanonicalRecordState>(
          prepared.value.current.records.map((record) => [record.ref.id, record]),
        );
        for (const change of prepared.value.changes) {
          const record = byId.get(change.id);
          if (record !== undefined)
            expected.push({ ref: record.ref, revision: record.localRevision });
        }
      }
      return kit.run(
        session.ownerId,
        commandId,
        focusEventTypes.reordered,
        expected,
        async ({ records }) => {
          if (!prepared.ok) return prepared;
          const { changes, current, date } = prepared.value;
          const readKeys = new Map(current.items.map((item) => [item.id, item.orderKey]));
          const refs = new Map<string, EntityRef>(
            current.records.map((record) => [record.ref.id, record.ref]),
          );
          const mutations: CanonicalMutation[] = [];
          for (const change of changes) {
            const ref = refs.get(change.id);
            const record = ref === undefined ? null : await records.read(ref);
            if (record === null) return changed('focus_changed');
            const document = editableSelection(record, session);
            if (!document.ok) return document;
            // Every row must still be where the person saw it: same date, same order key.
            if (
              document.value.periodStart !== date ||
              document.value.orderKey !== readKeys.get(change.id)
            )
              return changed('order_changed');
            mutations.push(updateFrom(record, { ...document.value, orderKey: change.orderKey }));
          }
          return ok({ mutations });
        },
      );
    },

    async setDayFocus(input, commandId) {
      const session = await kit.session();
      const raw: unknown = input;
      const prepared: DomainResult<PreparedDayFocus & { readonly desired: FocusTargetInput[] }> =
        await (async () => {
          if (!isRecord(raw) || !Array.isArray(raw['items'])) return invalid('focus_items');
          const day = await prepareDayFocus(kit, session, raw['date']);
          if (!day.ok) return day;
          return ok({ ...day.value, desired: [...input.items] });
        })();
      return kit.run(
        session.ownerId,
        commandId,
        focusSetEventType,
        prepared.ok ? prepared.value.current.expected : [],
        ({ records, context }) => {
          if (!prepared.ok) return prepared;
          const { current, date, desired } = prepared.value;
          return plannedFocus(kit, records, context, session, date, current.records, desired);
        },
      );
    },
  };
}
