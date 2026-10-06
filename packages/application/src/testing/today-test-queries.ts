/**
 * Test-only Today query port over the in-memory unit of work, plus a fixture seeder. It wraps the
 * planning test planning queries, follows the port's documented semantics (including the 48-hour block
 * lookback), and logs every call with its arguments so tests can assert that Today reads stay
 * bounded. It never writes.
 */
import {
  compareOrder,
  createEntityRef,
  dayBlockLookbackHours,
  occurrenceLogicalKey,
  occurrencePeriodKey,
  routineOccurrenceId,
  type ActionState,
  type CalendarDate,
  type EntityType,
  type GeneratedOccurrencePeriod,
  type HorizonPeriod,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type RecurrenceRuleV1,
  type RoutineSchedulingMode,
  type RoutineState,
  type UUID,
  type WeekPeriod,
} from '@yelaxis/domain';

import type { ActionCanonicalDocument } from '../actions';
import type { Bounded } from '../alignment-contracts';
import type { CanonicalRecordState } from '../contracts';
import type {
  ActionSummary,
  BlockRow,
  ConstraintDocument,
  ConstraintRow,
  FocusSelectionDocument,
  PlacementRow,
  PlanProfile,
  PlanningPlacementDocument,
  RoutineDocument,
  RoutineOccurrenceDocument,
  TimeBlockDocument,
  TimeBlockTargetDocument,
} from '../planning-contracts';
import { createTestPlanningQueries } from '../planning-routines-test-queries';
import type { DayFocusRow, FocusActionRow, TodayQueryPort } from '../today-contracts';
import type { InMemoryUnitOfWork } from './in-memory-unit-of-work';

type Doc = Readonly<Record<string, unknown>>;

export interface TodayQueryCall {
  readonly method: keyof TodayQueryPort;
  readonly args: readonly unknown[];
}

export interface TodayTestQueries extends TodayQueryPort {
  /** Every port call in order, with its arguments. */
  readonly calls: TodayQueryCall[];
}

const maxLimit = 200;
const lookbackMs = dayBlockLookbackHours * 3_600_000;
const unfinishedActions: readonly ActionState[] = ['inbox', 'planned', 'scheduled', 'in_progress'];

const clampLimit = (limit: number): number =>
  Number.isFinite(limit) ? Math.max(0, Math.min(Math.trunc(limit), maxLimit)) : maxLimit;

const bounded = <T>(items: readonly T[], limit: number): Bounded<T> => ({
  items: items.slice(0, clampLimit(limit)),
  total: items.length,
});

const byStart = (left: BlockRow, right: BlockRow): number =>
  Date.parse(left.startsAt) - Date.parse(right.startsAt) ||
  Date.parse(left.endsAt) - Date.parse(right.endsAt) ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const periodStart = (period: HorizonPeriod): string =>
  period.kind === 'day'
    ? period.date
    : period.kind === 'week'
      ? period.start
      : period.kind === 'month'
        ? `${period.month}-01`
        : `${period.year}-01-01`;

export function createTodayTestQueries(
  unitOfWork: InMemoryUnitOfWork,
  profile: PlanProfile,
): TodayTestQueries {
  const planning = createTestPlanningQueries(unitOfWork, profile);
  const calls: TodayQueryCall[] = [];
  const log = (method: keyof TodayQueryPort, args: readonly unknown[]): void => {
    calls.push({ method, args });
  };
  const all = (type: EntityType, ownerId: OwnerId): CanonicalRecordState[] =>
    [...unitOfWork.state.records.values()].filter(
      (record) => record.ref.type === type && record.ref.ownerId === ownerId,
    );
  const find = (type: EntityType, ownerId: OwnerId, id: string): CanonicalRecordState | null =>
    all(type, ownerId).find((record) => record.ref.id === id) ?? null;

  const blockRow = async (
    ownerId: OwnerId,
    record: CanonicalRecordState,
  ): Promise<BlockRow | undefined> => {
    const document = record.document as TimeBlockDocument;
    const rows = await planning.listBlocks(ownerId, document.startsAt, document.endsAt);
    return rows.find((row) => row.id === record.ref.id);
  };

  const placementsOn = async (ownerId: OwnerId, date: CalendarDate) =>
    (await planning.listPlacements(ownerId, { start: date, end: date })).filter(
      (row) => row.target.kind === 'action' && row.target.action.state !== 'archived',
    );

  return {
    calls,
    getPlanProfile(ownerId) {
      log('getPlanProfile', [ownerId]);
      return planning.getPlanProfile(ownerId);
    },
    readRecord(ownerId, ref) {
      log('readRecord', [ownerId, ref]);
      return planning.readRecord(ownerId, ref);
    },
    listRoutines(ownerId, options) {
      log('listRoutines', [ownerId, options]);
      return planning.listRoutines(ownerId, options);
    },
    listMaterializedOccurrences(ownerId, range, routineId) {
      log('listMaterializedOccurrences', [ownerId, range, routineId]);
      return planning.listMaterializedOccurrences(ownerId, range, routineId);
    },
    listCapacityConstraints(ownerId) {
      log('listCapacityConstraints', [ownerId]);
      const rows: ConstraintRow[] = all('constraint', ownerId)
        .filter((record) => {
          const document = record.document as ConstraintDocument;
          return (
            document.state === 'active' &&
            (document.constraintKind === 'availability' || document.constraintKind === 'capacity')
          );
        })
        .map((record) => ({
          id: record.ref.id,
          localRevision: record.localRevision,
          document: record.document as ConstraintDocument,
        }));
      return Promise.resolve(rows);
    },
    getActivePlacement(ownerId, kind, targetId) {
      log('getActivePlacement', [ownerId, kind, targetId]);
      return planning.getActivePlacement(ownerId, kind, targetId);
    },
    getPlannedActionBlock(ownerId, actionId) {
      log('getPlannedActionBlock', [ownerId, actionId]);
      return planning.getPlannedActionBlock(ownerId, actionId);
    },
    async listDayBlocks(ownerId, bounds) {
      log('listDayBlocks', [ownerId, bounds]);
      const earliest = Date.parse(bounds.startsAt) - lookbackMs;
      return (await planning.listBlocks(ownerId, bounds.startsAt, bounds.endsAt))
        .filter((row) => Date.parse(row.startsAt) >= earliest)
        .sort(byStart);
    },
    async listDayActionPlacements(ownerId, date) {
      log('listDayActionPlacements', [ownerId, date]);
      return (await placementsOn(ownerId, date))
        .filter((row) => row.period.kind === 'day' && row.period.date === date)
        .sort(compareOrder);
    },
    async listWeekActionPlacements(ownerId, date, limit) {
      log('listWeekActionPlacements', [ownerId, date, limit]);
      const rows: PlacementRow[] = [];
      for (const row of await placementsOn(ownerId, date)) {
        if (row.period.kind !== 'week' || row.target.kind !== 'action') continue;
        const state = row.target.action.state;
        if (state !== 'planned' && state !== 'in_progress') continue;
        if ((await planning.getPlannedActionBlock(ownerId, row.target.action.id)) !== null)
          continue;
        rows.push(row);
      }
      rows.sort(
        (left, right) =>
          periodStart(left.period).localeCompare(periodStart(right.period)) ||
          compareOrder(left, right),
      );
      return bounded(rows, limit);
    },
    async listWeekCommitmentActions(ownerId, date, limit) {
      log('listWeekCommitmentActions', [ownerId, date, limit]);
      const selections = all('focus_selection', ownerId)
        .map((record) => ({ record, document: record.document as FocusSelectionDocument }))
        .filter(
          ({ document }) =>
            document.kind === 'week_commitment' &&
            document.archivedAt === undefined &&
            document.target.kind === 'action' &&
            document.periodStart <= date &&
            date <= document.periodEnd,
        )
        .sort(
          (left, right) =>
            left.document.periodStart.localeCompare(right.document.periodStart) ||
            compareOrder(
              { id: left.record.ref.id, orderKey: left.document.orderKey },
              { id: right.record.ref.id, orderKey: right.document.orderKey },
            ),
        );
      const actions: ActionSummary[] = [];
      for (const { document } of selections) {
        if (document.target.kind !== 'action') continue;
        const action = await planning.getAction(ownerId, document.target.actionId);
        if (action !== null && unfinishedActions.includes(action.state)) actions.push(action);
      }
      return bounded(actions, limit);
    },
    async listDayFocus(ownerId, profileId, date) {
      log('listDayFocus', [ownerId, profileId, date]);
      const rows: DayFocusRow[] = [];
      for (const record of all('focus_selection', ownerId)) {
        const document = record.document as FocusSelectionDocument;
        if (
          document.kind !== 'day_focus' ||
          document.archivedAt !== undefined ||
          document.profileId !== profileId ||
          document.periodStart !== date
        )
          continue;
        const base = {
          id: record.ref.id,
          localRevision: record.localRevision,
          orderKey: document.orderKey,
          date,
        };
        if (document.target.kind === 'action') {
          const action = await planning.getAction(ownerId, document.target.actionId);
          if (action !== null) rows.push({ ...base, target: { kind: 'action', action } });
        } else if (document.target.kind === 'routine_occurrence') {
          const occurrence = find(
            'routine_occurrence',
            ownerId,
            document.target.routineOccurrenceId,
          );
          if (occurrence === null) continue;
          const occurrenceDocument = occurrence.document as RoutineOccurrenceDocument;
          const routine = find('routine', ownerId, occurrenceDocument.routineId);
          if (routine === null) continue;
          const routineDocument = routine.document as RoutineDocument;
          rows.push({
            ...base,
            target: {
              kind: 'routine_occurrence',
              occurrenceId: occurrence.ref.id,
              routineId: routine.ref.id,
              routineTitle: routineDocument.title,
              routineState: routineDocument.state,
              generation: occurrenceDocument.generation,
              period: occurrenceDocument.period,
              occurrenceRevision: occurrence.localRevision,
              state: occurrenceDocument.state,
            },
          });
        }
      }
      return rows.sort(compareOrder);
    },
    async getFocusAction(ownerId, actionId) {
      log('getFocusAction', [ownerId, actionId]);
      const summary = await planning.getAction(ownerId, actionId);
      if (summary === null) return null;
      const note = (find('action', ownerId, actionId)?.document as Doc | undefined)?.['note'];
      const block = await planning.getPlannedActionBlock(ownerId, actionId);
      const plannedBlock = block === null ? undefined : await blockRow(ownerId, block);
      const row: FocusActionRow = {
        ...summary,
        ...(typeof note === 'string' ? { note } : {}),
        ...(plannedBlock === undefined ? {} : { plannedBlock }),
      };
      return row;
    },
  };
}

/* ───────────────────────── Fixture seeder ───────────────────────── */

export interface TodaySeedOptions {
  readonly id?: UUID;
  readonly revision?: number;
}

/**
 * Seeds canonical records straight into the in-memory unit of work (fixtures only; no command,
 * event, or undo). Documents default to valid shapes and accept overrides.
 */
export interface TodaySeeder {
  action(
    overrides?: Partial<ActionCanonicalDocument>,
    options?: TodaySeedOptions,
  ): CanonicalRecordState;
  /** An active placement of an Action (Day, Week, or Month). */
  placement(
    actionId: UUID,
    period: HorizonPeriod,
    options?: TodaySeedOptions & { readonly orderKey?: string; readonly archivedAt?: Instant },
  ): CanonicalRecordState;
  /** A Time Block; `startsAt`/`endsAt` are canonical UTC instants. Planned by default. */
  block(
    target: TimeBlockTargetDocument,
    startsAt: string,
    endsAt: string,
    options?: TodaySeedOptions & {
      readonly state?: TimeBlockDocument['state'];
      readonly supersededById?: UUID;
      readonly overlapAcknowledged?: boolean;
      readonly timeZone?: IanaTimeZone;
    },
  ): CanonicalRecordState;
  /** A Routine with one generation. Day-flexible by default. */
  routine(
    rule: RecurrenceRuleV1,
    options?: TodaySeedOptions & {
      readonly title?: string;
      readonly schedulingMode?: RoutineSchedulingMode;
      readonly state?: RoutineState;
      readonly pauseEffectiveOn?: CalendarDate;
    },
  ): CanonicalRecordState;
  /** A materialized occurrence with its deterministic id (generation 1 by default). */
  occurrence(
    routineId: UUID,
    period: GeneratedOccurrencePeriod,
    overrides?: Partial<RoutineOccurrenceDocument>,
    options?: Omit<TodaySeedOptions, 'id'>,
  ): CanonicalRecordState;
  /** An active day focus selection of the seeded profile. */
  focus(
    target: FocusSelectionDocument['target'],
    date: string,
    options?: TodaySeedOptions & {
      readonly orderKey?: string;
      readonly archivedAt?: Instant;
      readonly profileId?: UUID;
    },
  ): CanonicalRecordState;
  /** An active Week commitment of an Action. */
  weekCommitment(
    actionId: UUID,
    week: WeekPeriod,
    options?: TodaySeedOptions & { readonly orderKey?: string; readonly archivedAt?: Instant },
  ): CanonicalRecordState;
  constraint(document: ConstraintDocument, options?: TodaySeedOptions): CanonicalRecordState;
}

export function createTodaySeeder(
  unitOfWork: InMemoryUnitOfWork,
  ownerId: OwnerId,
  profile: PlanProfile,
  idPrefix = 'e0000000-0000-4000-8000-',
): TodaySeeder {
  let sequence = 0;
  const nextId = (): UUID => {
    sequence += 1;
    return `${idPrefix}${String(sequence).padStart(12, '0')}` as UUID;
  };
  const orderKey = (): string => String(sequence * 1_000_000_000).padStart(15, '0');
  const seed = (type: EntityType, document: Doc, options: TodaySeedOptions = {}) => {
    const record: CanonicalRecordState = {
      ref: createEntityRef(type, options.id ?? nextId(), ownerId),
      localRevision: options.revision ?? 1,
      serverRevision: 0,
      baseSnapshotHash: null,
      document,
    };
    unitOfWork.seed(record);
    return record;
  };
  const pick = (options: TodaySeedOptions | undefined): TodaySeedOptions => ({
    ...(options?.id === undefined ? {} : { id: options.id }),
    ...(options?.revision === undefined ? {} : { revision: options.revision }),
  });
  return {
    action: (overrides = {}, options) =>
      seed(
        'action',
        {
          title: 'Draft the plan',
          captureOrigin: 'plan',
          orderKey: orderKey(),
          state: 'planned',
          ...overrides,
        },
        pick(options),
      ),
    placement: (actionId, period, options) =>
      seed(
        'planning_placement',
        {
          target: { kind: 'action', actionId },
          period,
          orderKey: options?.orderKey ?? orderKey(),
          ...(options?.archivedAt === undefined ? {} : { archivedAt: options.archivedAt }),
        } satisfies PlanningPlacementDocument,
        pick(options),
      ),
    block: (target, startsAt, endsAt, options) =>
      seed(
        'time_block',
        {
          target,
          startsAt: startsAt as Instant,
          endsAt: endsAt as Instant,
          timeZone: options?.timeZone ?? profile.planningTimeZone,
          state: options?.state ?? 'planned',
          ...(options?.supersededById === undefined
            ? {}
            : { supersededById: options.supersededById }),
          overlapAcknowledged: options?.overlapAcknowledged ?? false,
        } satisfies TimeBlockDocument,
        pick(options),
      ),
    routine: (rule, options) =>
      seed(
        'routine',
        {
          title: options?.title ?? 'Morning walk',
          orderKey: orderKey(),
          state: options?.state ?? 'active',
          ...(options?.pauseEffectiveOn === undefined
            ? {}
            : { pauseEffectiveOn: options.pauseEffectiveOn }),
          generations: [
            {
              generation: 1,
              rule,
              schedulingMode: options?.schedulingMode ?? { kind: 'day_flexible' },
            },
          ],
        } satisfies RoutineDocument,
        pick(options),
      ),
    occurrence: (routineId, period, overrides = {}, options) => {
      const generation = overrides.generation ?? 1;
      const id = routineOccurrenceId(occurrenceLogicalKey(routineId, generation, period));
      return seed(
        'routine_occurrence',
        {
          routineId,
          generation,
          periodKey: occurrencePeriodKey(period),
          period,
          state: 'planned',
          ...(period.kind === 'week' ? { targetCount: period.targetCount, completedCount: 0 } : {}),
          ...overrides,
        } satisfies RoutineOccurrenceDocument,
        { id, ...(options?.revision === undefined ? {} : { revision: options.revision }) },
      );
    },
    focus: (target, date, options) =>
      seed(
        'focus_selection',
        {
          kind: 'day_focus',
          profileId: options?.profileId ?? profile.profileId,
          target,
          periodStart: date as CalendarDate,
          periodEnd: date as CalendarDate,
          orderKey: options?.orderKey ?? orderKey(),
          ...(options?.archivedAt === undefined ? {} : { archivedAt: options.archivedAt }),
        } satisfies FocusSelectionDocument,
        pick(options),
      ),
    weekCommitment: (actionId, week, options) =>
      seed(
        'focus_selection',
        {
          kind: 'week_commitment',
          profileId: profile.profileId,
          target: { kind: 'action', actionId },
          periodStart: week.start,
          periodEnd: week.end,
          weekStart: week.weekStart,
          orderKey: options?.orderKey ?? orderKey(),
          ...(options?.archivedAt === undefined ? {} : { archivedAt: options.archivedAt }),
        } satisfies FocusSelectionDocument,
        pick(options),
      ),
    constraint: (document, options) => seed('constraint', document, pick(options)),
  };
}
