/**
 * Placement, carry-forward, ordering, Week commitment, capacity constraint, and Month theme / Year
 * direction commands. Capacity values are user guidance only; nothing here ranks or chooses.
 */
import {
  allowedPlacementKinds,
  createEntityRef,
  createWeekPeriod,
  err,
  isAvailabilityWindowOrdered,
  ok,
  parseCalendarDate,
  parseMonthKey,
  parseUUID,
  parseWallTime,
  parseYearKey,
  periodContaining,
  periodRange,
  spacedOrderKey,
  weekdays,
  type ConstraintStrength,
  type DomainResult,
  type HorizonPeriod,
  type OwnerId,
  type UUID,
  type WallTime,
  type Weekday,
} from '@yelaxis/domain';

import type { ActionCanonicalDocument } from './actions';
import type { CanonicalMutation, CanonicalRecordState, ExpectedRevision } from './contracts';
import type { SchedulingMethods } from './planning';
import type {
  AvailabilityInput,
  ConstraintDocument,
  FocusSelectionDocument,
  MonthThemeDocument,
  PlaceableTargetInput,
  PlacementPeriodInput,
  PlanningPlacementDocument,
  YearDirectionDocument,
} from './planning-contracts';
import { createMutation, updateFrom, type CreatedRecord } from './planning-kit';
import {
  actionWithState,
  changed,
  expectedOf,
  findActivePlacement,
  finishedActionStates,
  invalid,
  isArchivedDocument,
  missing,
  placeableKinds,
  placementTarget,
  rejectInvalid,
  rejected,
  samePeriod,
  upsertPlacement,
  type PlaceableKind,
  type SchedulingKit,
} from './planning-scheduling-support';
import {
  findActiveDirection,
  findActiveTheme,
  monthThemeText,
  planMonthTheme,
  planYearDirection,
  themeEventTypes,
  yearDirectionText,
} from './planning-themes';
import {
  checkWeekCommitmentTarget,
  planWeekCommitmentMutations,
  readWeekCommitments,
  removeWeekCommitmentMutation,
  weekCommitmentEventTypes,
  weekCommitmentKinds,
  weekCommitmentRef,
  weekCommitmentTargetOf,
  type WeekCommitmentTarget,
} from './planning-week-commitments';

type HorizonMethods = Pick<
  SchedulingMethods,
  | 'place'
  | 'unplace'
  | 'carryForward'
  | 'reorderPlacement'
  | 'addWeekCommitment'
  | 'removeWeekCommitment'
  | 'addAvailability'
  | 'editAvailability'
  | 'archiveConstraint'
  | 'setCapacityCap'
  | 'setMonthTheme'
  | 'clearMonthTheme'
  | 'setYearDirection'
  | 'clearYearDirection'
>;

const periodKinds: readonly HorizonPeriod['kind'][] = ['day', 'week', 'month', 'year'];
const constraintStrengths: readonly ConstraintStrength[] = ['hard', 'soft', 'unknown'];
const maxAvailabilityWindows = 28;
const maxCarryForward = 200;

function parsePeriod(input: PlacementPeriodInput, weekStart: Weekday): DomainResult<HorizonPeriod> {
  if (!periodKinds.includes(input.kind)) return invalid('period');
  return periodContaining(input.kind, typeof input.date === 'string' ? input.date : '', weekStart);
}

function parseTarget(
  input: PlaceableTargetInput,
): DomainResult<{ readonly kind: PlaceableKind; readonly id: UUID; readonly revision: number }> {
  if (!placeableKinds.includes(input.kind)) return invalid('target');
  const id = parseUUID(input.id);
  if (!id.ok) return id;
  return ok({ kind: input.kind, id: id.value, revision: input.revision });
}

function placementAllowed(kind: PlaceableKind, period: HorizonPeriod): DomainResult<true> {
  return allowedPlacementKinds[kind].includes(period.kind)
    ? ok(true)
    : err({
        code: 'placement_not_allowed',
        message: 'This item cannot be placed on that horizon.',
        details: { reason: 'placement_not_allowed', target: kind, horizon: period.kind },
      });
}

function parseWindows(
  windows: AvailabilityInput['windows'],
): DomainResult<ConstraintDocument['value'] & { readonly kind: 'availability' }> {
  const list: readonly unknown[] = Array.isArray(windows) ? (windows as readonly unknown[]) : [];
  if (list.length < 1 || list.length > maxAvailabilityWindows)
    return invalid('availability_windows');
  const parsed: { weekday: Weekday; start: WallTime; end: WallTime }[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) return invalid('availability_windows');
    const window = raw as Partial<Record<'weekday' | 'start' | 'end', unknown>>;
    const weekday = weekdays.find((candidate) => candidate === window.weekday);
    if (weekday === undefined) return invalid('availability_weekday');
    const start = parseWallTime(typeof window.start === 'string' ? window.start : '');
    const end = parseWallTime(typeof window.end === 'string' ? window.end : '');
    if (!start.ok || !end.ok) return invalid('availability_time');
    if (!isAvailabilityWindowOrdered(start.value, end.value)) return invalid('availability_order');
    parsed.push({ weekday, start: start.value, end: end.value });
  }
  return ok({ kind: 'availability', windows: parsed });
}

export function createHorizonCommands(kit: SchedulingKit): HorizonMethods {
  const { queries } = kit;

  const readTarget = async (
    ownerId: OwnerId,
    kind: PlaceableKind,
    id: UUID,
  ): Promise<{
    readonly ref: CanonicalRecordState['ref'];
    readonly record: CanonicalRecordState | null;
  }> => {
    const ref = createEntityRef(kind, id, ownerId);
    return { ref, record: await queries.readRecord(ownerId, ref) };
  };

  return {
    async place(input, commandId) {
      const target = parseTarget(input.target);
      if (!target.ok) return rejected(target.error);
      const { ownerId, profile } = await kit.session();
      const period = parsePeriod(input.period, profile.weekStart);
      if (!period.ok) return rejected(period.error);
      const allowed = placementAllowed(target.value.kind, period.value);
      if (!allowed.ok) return rejected(allowed.error);
      const { ref, record } = await readTarget(ownerId, target.value.kind, target.value.id);
      if (record === null) return missing(ref);
      const existing = await findActivePlacement(queries, ownerId, target.value.kind, ref.id);
      return kit.run(
        ownerId,
        commandId,
        'planning.placed',
        [{ ref, revision: target.value.revision }, ...expectedOf(existing)],
        async ({ records, context }) => {
          const current = await records.read(ref);
          if (current === null) return changed('target_missing');
          if (isArchivedDocument(current.document))
            return invalid('archived_target', 'Restore this item before placing it.');
          const mutations: CanonicalMutation[] = [];
          if (target.value.kind === 'action') {
            const action = current.document as ActionCanonicalDocument;
            if (action.state === 'scheduled')
              return invalid(
                'scheduled_action_use_move',
                'This Action has a planned block. Move the block to change its day.',
              );
            if (action.state === 'inbox') {
              const next = actionWithState(action, 'planned', context.now);
              if (!next.ok) return next;
              mutations.push(updateFrom(current, next.value));
            }
          }
          const placed = await upsertPlacement(
            records,
            ownerId,
            existing,
            placementTarget(target.value.kind, ref.id),
            period.value,
            kit.nextId,
          );
          if (!placed.ok) return placed;
          if (placed.value.mutation === null)
            return invalid('already_placed', 'This item is already placed there.');
          return ok({
            mutations: [...mutations, placed.value.mutation],
            created: placed.value.created === undefined ? [] : [placed.value.created],
          });
        },
      );
    },

    async unplace(input, commandId) {
      const target = parseTarget(input.target);
      if (!target.ok) return rejected(target.error);
      const ownerId = await kit.ownerId();
      const { ref, record } = await readTarget(ownerId, target.value.kind, target.value.id);
      if (record === null) return missing(ref);
      const existing = await findActivePlacement(queries, ownerId, target.value.kind, ref.id);
      return kit.run(
        ownerId,
        commandId,
        'planning.unplaced',
        [{ ref, revision: target.value.revision }, ...expectedOf(existing)],
        async ({ records, context }) => {
          if (existing === null) return invalid('not_placed', 'This item has no placement.');
          const current = await records.read(ref);
          if (current === null) return changed('target_missing');
          if (
            target.value.kind === 'action' &&
            (current.document as ActionCanonicalDocument).state === 'scheduled'
          )
            return invalid(
              'unschedule_first',
              'This Action has a planned block. Resolve or move the block first.',
            );
          const placement = await records.read(existing.ref);
          if (placement === null) return changed('placement_changed');
          const document = placement.document as PlanningPlacementDocument;
          if (document.archivedAt !== undefined) return changed('placement_changed');
          return ok({
            mutations: [updateFrom(placement, { ...document, archivedAt: context.now })],
          });
        },
      );
    },

    async carryForward(input, commandId) {
      if (input.period.kind !== 'day' && input.period.kind !== 'week')
        return rejectInvalid('carry_forward_period');
      if (input.actions.length < 1 || input.actions.length > maxCarryForward)
        return rejectInvalid('carry_forward_actions');
      const ids: UUID[] = [];
      for (const item of input.actions) {
        const id = parseUUID(item.id);
        if (!id.ok) return rejected(id.error);
        if (ids.includes(id.value)) return rejectInvalid('duplicate_action');
        ids.push(id.value);
      }
      const { ownerId, profile } = await kit.session();
      const period = parsePeriod(input.period, profile.weekStart);
      if (!period.ok) return rejected(period.error);
      const expected: ExpectedRevision[] = [];
      const items: {
        readonly ref: CanonicalRecordState['ref'];
        readonly placement: CanonicalRecordState | null;
      }[] = [];
      for (const [index, id] of ids.entries()) {
        const ref = createEntityRef('action', id, ownerId);
        const record = await queries.readRecord(ownerId, ref);
        if (record === null) return missing(ref);
        const placement = await findActivePlacement(queries, ownerId, 'action', id);
        expected.push(
          { ref, revision: input.actions[index]?.revision ?? -1 },
          ...expectedOf(placement),
        );
        items.push({ ref, placement });
      }
      return kit.run(
        ownerId,
        commandId,
        'planning.carried_forward',
        expected,
        async ({ records, context }) => {
          const mutations: CanonicalMutation[] = [];
          const created: CreatedRecord[] = [];
          for (const item of items) {
            const current = await records.read(item.ref);
            if (current === null) return changed('action_missing');
            const action = current.document as ActionCanonicalDocument;
            if (action.state === 'scheduled')
              return invalid(
                'scheduled_action_use_move',
                'A scheduled Action moves with its block.',
              );
            if (finishedActionStates.includes(action.state))
              return invalid('action_finished', 'Only unfinished Actions can be carried forward.');
            if (action.state === 'inbox') {
              const next = actionWithState(action, 'planned', context.now);
              if (!next.ok) return next;
              mutations.push(updateFrom(current, next.value));
            }
            const placed = await upsertPlacement(
              records,
              ownerId,
              item.placement,
              placementTarget('action', item.ref.id),
              period.value,
              kit.nextId,
            );
            if (!placed.ok) return placed;
            if (placed.value.mutation !== null) mutations.push(placed.value.mutation);
            if (placed.value.created !== undefined) created.push(placed.value.created);
          }
          if (mutations.length === 0)
            return invalid('already_placed', 'These Actions are already placed there.');
          return ok({ mutations, created });
        },
      );
    },

    async reorderPlacement(input, commandId) {
      const placementId = parseUUID(input.placementId);
      if (!placementId.ok) return rejected(placementId.error);
      if (input.direction !== 'up' && input.direction !== 'down') return rejectInvalid('direction');
      const { ownerId, profile } = await kit.session();
      const scope = parsePeriod(input.scope, profile.weekStart);
      if (!scope.ok) return rejected(scope.error);
      const rows = await queries.listPlacements(ownerId, periodRange(scope.value));
      const moving = rows.find((row) => row.id === placementId.value);
      if (moving === undefined)
        return missing(createEntityRef('planning_placement', placementId.value, ownerId));
      if (!samePeriod(moving.period, scope.value)) return rejectInvalid('not_in_scope');
      const ordered = rows
        .filter(
          (row) => samePeriod(row.period, scope.value) && row.target.kind === moving.target.kind,
        )
        .sort(
          (left, right) =>
            (left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0) ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        );
      const index = ordered.findIndex((row) => row.id === moving.id);
      const neighborIndex = index + (input.direction === 'up' ? -1 : 1);
      const neighbor = ordered[neighborIndex];
      if (neighbor === undefined) return rejectInvalid('order_edge');
      const keys = ordered.map((row) => row.orderKey);
      if (moving.orderKey === neighbor.orderKey)
        ordered.forEach((_row, position) => (keys[position] = spacedOrderKey(position)));
      const movingKey = keys[index];
      const neighborKey = keys[neighborIndex];
      if (movingKey === undefined || neighborKey === undefined) return rejectInvalid('order_edge');
      keys[index] = neighborKey;
      keys[neighborIndex] = movingKey;
      const changes = ordered
        .map((row, position) => ({ row, orderKey: keys[position] ?? row.orderKey }))
        .filter(({ row, orderKey }) => row.orderKey !== orderKey);
      const expected: ExpectedRevision[] = changes.map(({ row }) => ({
        ref: createEntityRef('planning_placement', row.id, ownerId),
        revision: row.id === moving.id ? input.revision : row.localRevision,
      }));
      return kit.run(
        ownerId,
        commandId,
        'planning.placement_reordered',
        expected,
        async ({ records }) => {
          const mutations: CanonicalMutation[] = [];
          for (const { row, orderKey } of changes) {
            const current = await records.read(
              createEntityRef('planning_placement', row.id, ownerId),
            );
            if (current === null) return changed('order_changed');
            const document = current.document as PlanningPlacementDocument;
            if (document.archivedAt !== undefined || document.orderKey !== row.orderKey)
              return changed('order_changed');
            mutations.push(updateFrom(current, { ...document, orderKey }));
          }
          return ok({ mutations });
        },
      );
    },

    async addWeekCommitment(input, commandId) {
      const kind = input.target.kind;
      if (!weekCommitmentKinds.includes(kind)) return rejectInvalid('target');
      const id = parseUUID(input.target.id);
      if (!id.ok) return rejected(id.error);
      const date = parseCalendarDate(input.weekDate);
      if (!date.ok) return rejected(date.error);
      const { ownerId, profile } = await kit.session();
      const week = createWeekPeriod(date.value, profile.weekStart);
      const target: WeekCommitmentTarget = { kind, id: id.value };
      const ref = weekCommitmentRef(ownerId, target);
      if ((await queries.readRecord(ownerId, ref)) === null) return missing(ref);
      const current = await readWeekCommitments(queries, ownerId, week);
      const duplicate = current.rows.some(
        (row) => row.target.kind === kind && row.target.id === id.value,
      );
      const chosen = current.records.flatMap((record) => {
        const kept = weekCommitmentTargetOf(record.document as FocusSelectionDocument);
        return kept === null ? [] : [kept];
      });
      // The new selection's id is drawn before the command, as it always has been.
      const selectionId = kit.nextId();
      return kit.run(
        ownerId,
        commandId,
        weekCommitmentEventTypes.added,
        [],
        async ({ records, context }) => {
          const available = await checkWeekCommitmentTarget(records, ref);
          if (!available.ok) return available;
          if (duplicate)
            return invalid('already_selected', 'This item is already a commitment for this week.');
          // Appending one target to the Week's list: kept rows keep their keys, and the new one
          // takes the next key (everyday planning has no cap of three, only a small-set warning).
          return planWeekCommitmentMutations(
            records,
            {
              ownerId,
              profileId: profile.profileId,
              week,
              existing: current.records,
              desired: [...chosen, target],
              keepKeys: true,
            },
            () => selectionId,
            context,
          );
        },
      );
    },

    async removeWeekCommitment(input, commandId) {
      const selectionId = parseUUID(input.selectionId);
      if (!selectionId.ok) return rejected(selectionId.error);
      const ownerId = await kit.ownerId();
      const ref = createEntityRef('focus_selection', selectionId.value, ownerId);
      if ((await queries.readRecord(ownerId, ref)) === null) return missing(ref);
      return kit.run(
        ownerId,
        commandId,
        weekCommitmentEventTypes.removed,
        [{ ref, revision: input.revision }],
        async ({ records, context }) => {
          const current = await records.read(ref);
          if (current === null) return changed('selection_missing');
          const mutation = removeWeekCommitmentMutation(current, context.now);
          return mutation.ok ? ok({ mutations: [mutation.value] }) : mutation;
        },
      );
    },

    async addAvailability(input, commandId) {
      if (!constraintStrengths.includes(input.strength)) return rejectInvalid('strength');
      const value = parseWindows(input.windows);
      if (!value.ok) return rejected(value.error);
      const ownerId = await kit.ownerId();
      const ref = createEntityRef('constraint', kit.nextId(), ownerId);
      return kit.run(ownerId, commandId, 'planning.availability_added', [], () => {
        const document: ConstraintDocument = {
          constraintKind: 'availability',
          strength: input.strength,
          value: value.value,
          state: 'active',
        };
        return ok({
          mutations: [createMutation(ref, document)],
          created: [{ ref, kind: 'constraint' }],
        });
      });
    },

    async editAvailability(input, commandId) {
      const constraintId = parseUUID(input.constraintId);
      if (!constraintId.ok) return rejected(constraintId.error);
      if (!constraintStrengths.includes(input.strength)) return rejectInvalid('strength');
      const value = parseWindows(input.windows);
      if (!value.ok) return rejected(value.error);
      const ownerId = await kit.ownerId();
      const ref = createEntityRef('constraint', constraintId.value, ownerId);
      if ((await queries.readRecord(ownerId, ref)) === null) return missing(ref);
      return kit.run(
        ownerId,
        commandId,
        'planning.availability_edited',
        [{ ref, revision: input.revision }],
        async ({ records }) => {
          const current = await records.read(ref);
          if (current === null) return changed('constraint_missing');
          const document = current.document as ConstraintDocument;
          if (document.state !== 'active' || document.constraintKind !== 'availability')
            return invalid('not_active_availability');
          return ok({
            mutations: [
              updateFrom(current, { ...document, strength: input.strength, value: value.value }),
            ],
          });
        },
      );
    },

    async archiveConstraint(input, commandId) {
      const constraintId = parseUUID(input.constraintId);
      if (!constraintId.ok) return rejected(constraintId.error);
      const ownerId = await kit.ownerId();
      const ref = createEntityRef('constraint', constraintId.value, ownerId);
      if ((await queries.readRecord(ownerId, ref)) === null) return missing(ref);
      return kit.run(
        ownerId,
        commandId,
        'planning.constraint_archived',
        [{ ref, revision: input.revision }],
        async ({ records, context }) => {
          const current = await records.read(ref);
          if (current === null) return changed('constraint_missing');
          const document = current.document as ConstraintDocument;
          if (document.state !== 'active') return invalid('already_archived');
          return ok({
            mutations: [
              updateFrom(current, {
                ...document,
                state: 'archived',
                stateBeforeArchive: 'active',
                archivedAt: context.now,
              }),
            ],
          });
        },
      );
    },

    async setCapacityCap(input, commandId) {
      const period = input.period;
      if (period !== 'day' && period !== 'week') return rejectInvalid('cap_period');
      const minutes = input.minutes;
      const limit = period === 'day' ? 1440 : 10080;
      if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > limit))
        return rejectInvalid('cap_minutes');
      const ownerId = await kit.ownerId();
      const row = (await queries.listCapacityConstraints(ownerId)).find(
        ({ document }) =>
          document.state === 'active' &&
          document.constraintKind === 'capacity' &&
          document.value.kind === 'capacity' &&
          document.value.period === period,
      );
      const existing =
        row === undefined
          ? null
          : await queries.readRecord(ownerId, createEntityRef('constraint', row.id, ownerId));
      const newRef = createEntityRef('constraint', kit.nextId(), ownerId);
      return kit.run(
        ownerId,
        commandId,
        minutes === null ? 'planning.capacity_cap_cleared' : 'planning.capacity_cap_set',
        expectedOf(existing),
        async ({ records, context }) => {
          const current = existing === null ? null : await records.read(existing.ref);
          const document = current?.document as ConstraintDocument | undefined;
          if (current !== null && document?.state !== 'active') return changed('cap_changed');
          if (minutes === null) {
            if (current === null || document === undefined)
              return invalid('nothing_to_clear', 'There is no limit to clear.');
            return ok({
              mutations: [
                updateFrom(current, {
                  ...document,
                  state: 'archived',
                  stateBeforeArchive: 'active',
                  archivedAt: context.now,
                }),
              ],
            });
          }
          const value = { kind: 'capacity' as const, period, minutes };
          if (current !== null && document !== undefined)
            return ok({ mutations: [updateFrom(current, { ...document, value })] });
          const created: ConstraintDocument = {
            constraintKind: 'capacity',
            strength: 'soft',
            value,
            state: 'active',
          };
          return ok({
            mutations: [createMutation(newRef, created)],
            created: [{ ref: newRef, kind: 'constraint' }],
          });
        },
      );
    },

    async setMonthTheme(input, commandId) {
      const month = parseMonthKey(typeof input.month === 'string' ? input.month : '');
      if (!month.ok) return rejected(month.error);
      const text = monthThemeText(input.text);
      if (!text.ok) return rejected(text.error);
      const { ownerId, profile } = await kit.session();
      const existing = await findActiveTheme(queries, ownerId, month.value);
      const newRef = createEntityRef('theme', kit.nextId(), ownerId);
      return kit.run(
        ownerId,
        commandId,
        themeEventTypes.monthThemeSet,
        expectedOf(existing),
        async ({ records }) => {
          const plan = await planMonthTheme(records, {
            existing,
            profileId: profile.profileId,
            month: month.value,
            text: text.value,
            newRef,
          });
          if (!plan.ok) return plan;
          return ok({
            mutations: [plan.value.mutation],
            created: plan.value.created === undefined ? [] : [plan.value.created],
          });
        },
      );
    },

    async clearMonthTheme(input, commandId) {
      const month = parseMonthKey(typeof input.month === 'string' ? input.month : '');
      if (!month.ok) return rejected(month.error);
      const ownerId = await kit.ownerId();
      const existing = await findActiveTheme(queries, ownerId, month.value);
      return kit.run(
        ownerId,
        commandId,
        'planning.month_theme_cleared',
        expectedOf(existing),
        async ({ records, context }) => {
          const current = existing === null ? null : await records.read(existing.ref);
          if (current === null) return invalid('nothing_to_clear', 'This month has no theme.');
          const document = current.document as MonthThemeDocument;
          if (document.archivedAt !== undefined) return changed('theme_changed');
          return ok({ mutations: [updateFrom(current, { ...document, archivedAt: context.now })] });
        },
      );
    },

    async setYearDirection(input, commandId) {
      const year = parseYearKey(typeof input.year === 'string' ? input.year : '');
      if (!year.ok) return rejected(year.error);
      const text = yearDirectionText(input.text);
      if (!text.ok) return rejected(text.error);
      const { ownerId, profile } = await kit.session();
      const existing = await findActiveDirection(queries, ownerId, year.value);
      const newRef = createEntityRef('direction', kit.nextId(), ownerId);
      return kit.run(
        ownerId,
        commandId,
        themeEventTypes.yearDirectionSet,
        expectedOf(existing),
        async ({ records }) => {
          const plan = await planYearDirection(records, {
            existing,
            profileId: profile.profileId,
            year: year.value,
            text: text.value,
            newRef,
          });
          if (!plan.ok) return plan;
          return ok({
            mutations: [plan.value.mutation],
            created: plan.value.created === undefined ? [] : [plan.value.created],
          });
        },
      );
    },

    async clearYearDirection(input, commandId) {
      const year = parseYearKey(typeof input.year === 'string' ? input.year : '');
      if (!year.ok) return rejected(year.error);
      const ownerId = await kit.ownerId();
      const existing = await findActiveDirection(queries, ownerId, year.value);
      return kit.run(
        ownerId,
        commandId,
        'planning.year_direction_cleared',
        expectedOf(existing),
        async ({ records, context }) => {
          const current = existing === null ? null : await records.read(existing.ref);
          if (current === null) return invalid('nothing_to_clear', 'This year has no direction.');
          const document = current.document as YearDirectionDocument;
          if (document.archivedAt !== undefined) return changed('direction_changed');
          return ok({ mutations: [updateFrom(current, { ...document, archivedAt: context.now })] });
        },
      );
    },
  };
}
