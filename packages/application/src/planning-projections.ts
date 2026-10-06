/**
 * planning read models. Every method reads through the planning query port and applies pure domain
 * rules; nothing here writes, ranks, or chooses for the user. Capacity is neutral guidance and
 * unknown availability is reported as unknown, never as free time.
 */
import {
  addDays,
  calculateWeekCapacity,
  createEntityRef,
  createWeekPeriod,
  currentPlanningDate,
  datesInRange,
  intervalsIntersect,
  localRangeBounds,
  localWallTimeOf,
  monthRange,
  monthsOfYear,
  parseCalendarDate,
  parseMonthKey,
  parseRoutineDefinition,
  parseTemplateBlueprint,
  parseUUID,
  parseWallTime,
  parseYearKey,
  periodRange,
  plannedMinutesOnDate,
  previewTemplateApplication,
  projectRoutineOccurrences,
  rangesOverlap,
  resolveLocalInterval as resolveZonedInterval,
  weeksOfMonth,
  yearRange,
  MAX_BLOCK_MINUTES,
  MIN_BLOCK_MINUTES,
  type ActionState,
  type CalendarDate,
  type DateRange,
  type HorizonPeriod,
  type MaterializedOccurrenceSnapshot,
  type MonthKey,
  type OwnerId,
  type ProjectedOccurrence,
  type RoutineSeriesSnapshot,
  type TemplateBlueprint,
  type UUID,
  type WeekPeriod,
  type YearKey,
} from '@yelaxis/domain';

import type { ProjectionMethods } from './planning';
import type {
  CapacitySettings,
  ConstraintRow,
  ImportantDate,
  MilestoneRow,
  OccurrenceEntry,
  OutcomeRow,
  PlanProfile,
  PlanningQueryPort,
  RoutinePreviewEntry,
  RoutineRow,
  RoutineSummary,
  TemplateDetail,
  TemplateListItem,
  TemplateRow,
  WeekDensity,
} from './planning-contracts';
import { domainFailure, invalid, notFound } from './planning-kit';
import {
  buildRangeSnapshot,
  capacityRules,
  compareInstants,
  compareOrder,
  conflictsWithin,
  dayColumn,
  isActionPlacement,
  occurrenceEntry,
  occurrenceTimingView,
  placedAction,
  type RangeSnapshot,
} from './planning-projections-range';
import { previewOccurrenceEdit } from './planning-routines-occurrences';
import { scanTemplateOverlaps } from './planning-templates-apply';
import { collectPlannedTimedItems, overlapsFor, routineSnapshot } from './planning-timed-items';
import type { ApplicationDependencies } from './ports';
import {
  builtInTemplates,
  findBuiltInTemplate,
  templateCatalogVersion,
  type BuiltInTemplate,
} from './template-catalog';

const backlogLimits = { day: 20, week: 50 } as const;
const carryForwardLimit = 50;
const routineUpcomingDays = 28;
const routineHistoryLimit = 20;
const previewDefaultCount = 10;
const previewMaxCount = 100;
const previewDays = 400;
const previewWeeks = 104;
/** Placeholder identity for projecting an unsaved Routine; never persisted. */
const previewRoutineId = '00000000-0000-4000-8000-000000000000' as UUID;

const inactiveActions = new Set<ActionState>(['canceled', 'archived']);

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/** Neutral duration text: "12 hours 30 minutes", "1 hour", "0 minutes". */
export function durationText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(plural(hours, 'hour'));
  if (rest > 0 || hours === 0) parts.push(plural(rest, 'minute'));
  return parts.join(' ');
}

export function densitySummary(
  plannedMinutes: number,
  commitmentCount: number,
  milestoneCount: number,
): string {
  return `${durationText(plannedMinutes)} planned, ${plural(
    commitmentCount,
    'commitment',
  )}, ${plural(milestoneCount, 'milestone')}`;
}

function requireDate(value: string): CalendarDate {
  const parsed = parseCalendarDate(value);
  if (!parsed.ok) throw new RangeError('Choose a valid date.');
  return parsed.value;
}

const placementOverlaps = (
  placement: { readonly period: HorizonPeriod } | undefined,
  range: DateRange,
  kinds: readonly HorizonPeriod['kind'][],
): boolean =>
  placement !== undefined &&
  kinds.includes(placement.period.kind) &&
  rangesOverlap(periodRange(placement.period), range);

const targetEndWithin = (
  row: { readonly targetEnd?: CalendarDate },
  range: DateRange,
): row is { readonly targetEnd: CalendarDate } =>
  row.targetEnd !== undefined && row.targetEnd >= range.start && row.targetEnd <= range.end;

function lowestCap(
  constraints: readonly ConstraintRow[],
  period: 'day' | 'week',
): CapacitySettings['dayCap'] {
  let best: CapacitySettings['dayCap'];
  for (const row of constraints) {
    const value = row.document.value;
    if (row.document.state !== 'active' || value.kind !== 'capacity' || value.period !== period)
      continue;
    if (
      best === undefined ||
      value.minutes < best.minutes ||
      (value.minutes === best.minutes && row.id < best.id)
    )
      best = { id: row.id, localRevision: row.localRevision, minutes: value.minutes };
  }
  return best;
}

function routineSummary(row: RoutineRow): RoutineSummary | null {
  const current = row.document.generations.at(-1);
  if (current === undefined) return null;
  const document = row.document;
  return {
    id: row.id,
    localRevision: row.localRevision,
    title: document.title,
    ...(document.description === undefined ? {} : { description: document.description }),
    ...(document.axisId === undefined ? {} : { axisId: document.axisId }),
    ...(row.axisTitle === undefined ? {} : { axisTitle: row.axisTitle }),
    state: document.state,
    ...(document.pauseEffectiveOn === undefined
      ? {}
      : { pauseEffectiveOn: document.pauseEffectiveOn }),
    generations: document.generations,
    current,
    ...(row.defaults === undefined ? {} : { defaults: row.defaults }),
  };
}

const effectiveStart = (row: MaterializedOccurrenceSnapshot): CalendarDate =>
  row.period.kind === 'week' ? row.period.start : (row.override?.date ?? row.period.date);
const effectiveEnd = (row: MaterializedOccurrenceSnapshot): CalendarDate =>
  row.period.kind === 'week' ? row.period.end : (row.override?.date ?? row.period.date);

/** Materialized history mapped to entries, newest first, with timing resolved by the domain. */
function historyEntries(
  routine: RoutineRow,
  rows: readonly MaterializedOccurrenceSnapshot[],
  planningTimeZone: PlanProfile['planningTimeZone'],
): readonly OccurrenceEntry[] {
  if (rows.length === 0) return [];
  const window = {
    start: rows.map(effectiveStart).reduce((left, right) => (right < left ? right : left)),
    end: rows.map(effectiveEnd).reduce((left, right) => (right > left ? right : left)),
  };
  // An archived snapshot projects only the materialized rows, never generated occurrences.
  const series: RoutineSeriesSnapshot = { ...routineSnapshot(routine), state: 'archived' };
  const projected = projectRoutineOccurrences({
    series,
    materialized: rows,
    window,
    planningTimeZone,
  });
  const byId = new Map<string, ProjectedOccurrence>(
    projected.ok ? projected.value.map((item) => [item.id, item]) : [],
  );
  return rows.map((row) => {
    const item = byId.get(row.id);
    if (item !== undefined) return occurrenceEntry(routine, item);
    const date = row.period.kind === 'date' ? (row.override?.date ?? row.period.date) : undefined;
    return occurrenceEntry(routine, {
      id: row.id,
      routineId: row.routineId,
      generation: row.generation,
      logicalKey: row.logicalKey,
      period: row.period,
      ...(date === undefined ? {} : { date }),
      moved: row.override?.date !== undefined,
      state: row.state,
      materialized: true,
      localRevision: row.localRevision,
      timing: row.period.kind === 'week' ? { kind: 'weekly_count' } : { kind: 'flexible' },
      ...(row.targetCount === undefined ? {} : { targetCount: row.targetCount }),
      ...(row.completedCount === undefined ? {} : { completedCount: row.completedCount }),
      overlapAcknowledged: row.override?.overlapAcknowledged === true,
    });
  });
}

/** Local start and DST note for a previewed occurrence, detected from the resolved instant. */
function previewEntry(occurrence: ProjectedOccurrence): RoutinePreviewEntry {
  const base = {
    ...(occurrence.date === undefined ? {} : { date: occurrence.date }),
    period: occurrence.period,
    timing: occurrenceTimingView(occurrence.timing),
  };
  const timing = occurrence.timing;
  if (timing.kind === 'dst_skipped') return { ...base, dstNote: 'gap_skipped' };
  if (timing.kind !== 'timed' || occurrence.date === undefined) return base;
  const localStart = localWallTimeOf(timing.startsAt, timing.timeZone);
  const reference = resolveZonedInterval(occurrence.date, timing.wallTime, 1, timing.timeZone);
  if (reference.adjustment === 'dst_gap_shifted')
    return { ...base, localStart, dstNote: 'gap_shifted' };
  if (reference.adjustment === 'dst_repeated_earlier')
    return {
      ...base,
      localStart,
      dstNote:
        compareInstants(reference.startsAt, timing.startsAt) === 0
          ? 'repeated_earlier'
          : 'repeated_later',
    };
  return { ...base, localStart };
}

const builtInItem = (template: BuiltInTemplate): TemplateListItem => ({
  id: template.id,
  source: 'built_in',
  title: template.title,
  description: template.description,
  itemCount: template.blueprint.items.length,
  blueprintVersion: template.blueprint.version,
  state: 'active',
  catalogVersion: templateCatalogVersion,
});

const userItem = (row: TemplateRow): TemplateListItem => ({
  id: row.id,
  source: 'user',
  title: row.document.title,
  itemCount: row.document.blueprint.items.length,
  blueprintVersion: row.document.blueprint.version,
  state: row.document.state,
  localRevision: row.localRevision,
});

export function createPlanningProjections(
  dependencies: ApplicationDependencies,
  queries: PlanningQueryPort,
): ProjectionMethods {
  const owner = async (): Promise<OwnerId> => {
    const active = await dependencies.identityContext.getActiveIdentity();
    if (active === null) throw new Error('No active identity');
    return active.ownerId;
  };
  const context = async (): Promise<{
    readonly ownerId: OwnerId;
    readonly profile: PlanProfile;
    readonly today: CalendarDate;
  }> => {
    const ownerId = await owner();
    const profile = await queries.getPlanProfile(ownerId);
    return {
      ownerId,
      profile,
      today: currentPlanningDate(dependencies.clock, profile.planningTimeZone),
    };
  };

  const weekActions = (snapshot: RangeSnapshot, week: WeekPeriod) =>
    snapshot.placements
      .filter(isActionPlacement)
      .filter(
        (row) =>
          row.period.kind === 'week' &&
          rangesOverlap(periodRange(row.period), week) &&
          !inactiveActions.has(row.target.action.state),
      )
      .sort(compareOrder)
      .map(placedAction);

  return {
    async getDayPlan(date) {
      const day = requireDate(date);
      const { ownerId, profile, today } = await context();
      const week = createWeekPeriod(day, profile.weekStart);
      const snapshot = await buildRangeSnapshot(queries, ownerId, profile, week);
      const backlog = await queries.listBacklog(ownerId, backlogLimits.day);
      return {
        profile,
        today,
        day: dayColumn(snapshot, day),
        week,
        conflicts: conflictsWithin(
          snapshot.conflicts,
          { start: day, end: day },
          profile.planningTimeZone,
        ),
        weeklyCounts: snapshot.weekly.map((item) => item.entry),
        backlog,
      };
    },

    async getWeekPlan(date) {
      const day = requireDate(date);
      const { ownerId, profile, today } = await context();
      const week = createWeekPeriod(day, profile.weekStart);
      const snapshot = await buildRangeSnapshot(queries, ownerId, profile, week);
      const carryForward = await queries.listCarryForward(ownerId, week.start, carryForwardLimit);
      const weekCommitments = await queries.listWeekSelections(ownerId, week);
      const backlog = await queries.listBacklog(ownerId, backlogLimits.week);
      return {
        profile,
        today,
        week,
        capacity: calculateWeekCapacity(
          week,
          snapshot.work,
          snapshot.rules,
          profile.planningTimeZone,
        ),
        days: datesInRange(week).map((value) => dayColumn(snapshot, value)),
        fixed: snapshot.entries.filter((entry) => entry.kind === 'commitment_block'),
        conflicts: snapshot.conflicts,
        carryForward,
        weekActions: weekActions(snapshot, week),
        weekObjects: snapshot.placements
          .filter(
            (row) =>
              (row.target.kind === 'project' || row.target.kind === 'milestone') &&
              row.period.kind === 'week' &&
              rangesOverlap(periodRange(row.period), week),
          )
          .sort(compareOrder),
        weekCommitments,
        weeklyCounts: snapshot.weekly.map((item) => item.entry),
        backlog,
      };
    },

    async getMonthPlan(value) {
      const parsed = parseMonthKey(value);
      if (!parsed.ok) throw new RangeError('Choose a valid month.');
      const month: MonthKey = parsed.value;
      const { ownerId, profile, today } = await context();
      const zone = profile.planningTimeZone;
      const range = monthRange(month);
      const weeks = weeksOfMonth(month, profile.weekStart);
      const first = weeks[0];
      const last = weeks.at(-1);
      const fullRange: DateRange =
        first === undefined || last === undefined ? range : { start: first.start, end: last.end };
      const snapshot = await buildRangeSnapshot(queries, ownerId, profile, fullRange);
      const themes = await queries.listMonthThemes(ownerId, month.slice(0, 4) as YearKey);
      const fullMilestones = await queries.listMilestones(ownerId, fullRange);
      const milestones = await queries.listMilestones(ownerId, range);
      const projectTargets = await queries.listProjectTargets(ownerId, range);
      const outcomes = await queries.listOutcomes(ownerId, range);

      const countedCommitments = snapshot.entries.filter(
        (entry) =>
          entry.kind === 'commitment_block' &&
          (entry.state === 'planned' || entry.state === 'completed'),
      );
      const density: WeekDensity[] = weeks.map((week) => {
        const plannedMinutes = datesInRange(week).reduce(
          (total, date) => total + plannedMinutesOnDate(date, snapshot.work, zone),
          0,
        );
        const commitmentCount = countedCommitments.filter(
          (entry) => entry.localDate >= week.start && entry.localDate <= week.end,
        ).length;
        const milestoneCount = fullMilestones.filter(
          (row) =>
            placementOverlaps(row.placement, week, ['week', 'day']) || targetEndWithin(row, week),
        ).length;
        return {
          week,
          plannedMinutes,
          commitmentCount,
          milestoneCount,
          summary: densitySummary(plannedMinutes, commitmentCount, milestoneCount),
        };
      });
      const monthBounds = localRangeBounds(range, zone);
      const theme = themes.find((row) => row.month === month);
      return {
        profile,
        today,
        month,
        range,
        ...(theme === undefined ? {} : { theme }),
        weeks: density,
        milestones,
        commitments: snapshot.entries.filter(
          (entry) => entry.kind === 'commitment_block' && intervalsIntersect(entry, monthBounds),
        ),
        projectTargets,
        outcomes,
        monthActions: snapshot.placements
          .filter(isActionPlacement)
          .filter(
            (row) =>
              row.period.kind === 'month' &&
              row.period.month === month &&
              !inactiveActions.has(row.target.action.state),
          )
          .sort(compareOrder)
          .map(placedAction),
      };
    },

    async getYearPlan(value) {
      const parsed = parseYearKey(value);
      if (!parsed.ok) throw new RangeError('Choose a valid year.');
      const year = parsed.value;
      const { ownerId, profile, today } = await context();
      const range = yearRange(year);
      const direction = await queries.getYearDirection(ownerId, year);
      const themes = await queries.listMonthThemes(ownerId, year);
      const outcomes = (await queries.listOutcomes(ownerId, range)).filter(
        (row) => row.state === 'active' || row.state === 'paused',
      );
      const milestones = await queries.listMilestones(ownerId, range);
      const projects = await queries.listProjectTargets(ownerId, range);
      const inMonth = (row: OutcomeRow | MilestoneRow, monthDates: DateRange): boolean =>
        placementOverlaps(row.placement, monthDates, ['day', 'week', 'month']) ||
        targetEndWithin(row, monthDates);
      const importantDates: ImportantDate[] = [
        ...outcomes.flatMap((row): ImportantDate[] =>
          targetEndWithin(row, range)
            ? [{ date: row.targetEnd, kind: 'outcome_target', id: row.id, title: row.title }]
            : [],
        ),
        ...milestones.flatMap((row): ImportantDate[] =>
          targetEndWithin(row, range)
            ? [{ date: row.targetEnd, kind: 'milestone_target', id: row.id, title: row.title }]
            : [],
        ),
        ...projects.flatMap((row): ImportantDate[] =>
          targetEndWithin(row, range)
            ? [{ date: row.targetEnd, kind: 'project_target', id: row.id, title: row.title }]
            : [],
        ),
      ].sort(
        (left, right) =>
          (left.date < right.date ? -1 : left.date > right.date ? 1 : 0) ||
          left.title.localeCompare(right.title) ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );
      return {
        profile,
        today,
        year,
        ...(direction === null ? {} : { direction }),
        months: monthsOfYear(year).map((month) => {
          const monthDates = monthRange(month);
          const theme = themes.find((row) => row.month === month);
          return {
            month,
            ...(theme === undefined ? {} : { theme }),
            milestoneCount: milestones.filter((row) => inMonth(row, monthDates)).length,
            outcomeCount: outcomes.filter((row) => inMonth(row, monthDates)).length,
          };
        }),
        outcomes,
        milestones,
        importantDates,
      };
    },

    async getMilestoneChain(milestoneId) {
      const id = parseUUID(milestoneId);
      if (!id.ok) return null;
      return queries.getMilestoneChain(await owner(), id.value);
    },

    async resolveLocalInterval(input, exclude = []) {
      if ('occurrence' in input) {
        const { ownerId, profile } = await context();
        return previewOccurrenceEdit(queries, ownerId, profile.planningTimeZone, input, exclude);
      }
      const date = parseCalendarDate(input.date);
      if (!date.ok) return domainFailure(invalid('date', 'Choose a valid date.'));
      const startTime = /^\d{2}:\d{2}$/u.test(input.startTime)
        ? parseWallTime(input.startTime)
        : null;
      if (startTime === null || !startTime.ok)
        return domainFailure(invalid('start_time', 'Choose a valid start time.'));
      const duration = input.durationMinutes;
      if (
        !Number.isInteger(duration) ||
        duration < MIN_BLOCK_MINUTES ||
        duration > MAX_BLOCK_MINUTES
      )
        return domainFailure(
          invalid(
            'duration_minutes',
            `Duration must be between ${MIN_BLOCK_MINUTES} and ${MAX_BLOCK_MINUTES} minutes.`,
          ),
        );
      const { ownerId, profile } = await context();
      const resolved = resolveZonedInterval(
        date.value,
        startTime.value,
        duration,
        profile.planningTimeZone,
      );
      const candidates = await collectPlannedTimedItems(
        queries,
        ownerId,
        profile.planningTimeZone,
        resolved.startsAt,
        resolved.endsAt,
      );
      return {
        ok: true,
        value: {
          ...resolved,
          overlaps: overlapsFor(candidates, resolved, exclude).map(({ key, title }) => ({
            key,
            title,
          })),
        },
      };
    },

    async listRoutines(options = {}) {
      const rows = await queries.listRoutines(await owner(), {
        includeArchived: options.includeArchived ?? false,
      });
      return rows.flatMap((row) => {
        const summary = routineSummary(row);
        return summary === null ? [] : [summary];
      });
    },

    async getRoutine(routineId) {
      const id = parseUUID(routineId);
      if (!id.ok) return null;
      const { ownerId, profile, today } = await context();
      const row = await queries.getRoutine(ownerId, id.value);
      if (row === null) return null;
      const routine = routineSummary(row);
      if (routine === null) return null;
      const window = { start: today, end: addDays(today, routineUpcomingDays - 1) };
      const materialized = await queries.listMaterializedOccurrences(ownerId, window, id.value);
      const projected = projectRoutineOccurrences({
        series: routineSnapshot(row),
        materialized,
        window,
        planningTimeZone: profile.planningTimeZone,
      });
      const history = await queries.listOccurrenceHistory(ownerId, id.value, routineHistoryLimit);
      return {
        routine,
        profile,
        today,
        upcoming: projected.ok ? projected.value.map((item) => occurrenceEntry(row, item)) : [],
        history: historyEntries(row, history, profile.planningTimeZone),
      };
    },

    async previewRoutine(input, count = previewDefaultCount) {
      if (!Number.isInteger(count) || count < 1 || count > previewMaxCount)
        return domainFailure(invalid('count'));
      const definition = parseRoutineDefinition({
        title: 'Preview',
        rule: input.rule,
        schedulingMode: input.schedulingMode,
      });
      if (!definition.ok) return domainFailure(definition);
      const { profile, today } = await context();
      const rule = definition.value.rule;
      const start = rule.startsOn > today ? rule.startsOn : today;
      const window = {
        start,
        end: addDays(start, rule.kind === 'weekly_count' ? previewWeeks * 7 - 1 : previewDays - 1),
      };
      const projected = projectRoutineOccurrences({
        series: {
          id: previewRoutineId,
          state: 'active',
          generations: [{ generation: 1, rule, schedulingMode: definition.value.schedulingMode }],
        },
        materialized: [],
        window,
        planningTimeZone: profile.planningTimeZone,
      });
      if (!projected.ok) return domainFailure(projected);
      return { ok: true, value: projected.value.slice(0, count).map(previewEntry) };
    },

    async listTemplates(options = {}) {
      const includeArchived = options.includeArchived ?? false;
      const rows = await queries.listTemplates(await owner(), { includeArchived });
      return [
        ...builtInTemplates.map(builtInItem),
        ...rows.filter((row) => includeArchived || row.document.state === 'active').map(userItem),
      ];
    },

    async getTemplate(templateId): Promise<TemplateDetail | null> {
      const builtIn = findBuiltInTemplate(templateId);
      if (builtIn !== undefined) return { ...builtInItem(builtIn), blueprint: builtIn.blueprint };
      const id = parseUUID(templateId);
      if (!id.ok) return null;
      const row = await queries.getTemplate(await owner(), id.value);
      return row === null ? null : { ...userItem(row), blueprint: row.document.blueprint };
    },

    async previewTemplate(input) {
      let blueprint: TemplateBlueprint;
      const builtIn = findBuiltInTemplate(input.templateId);
      if (builtIn !== undefined) {
        blueprint = builtIn.blueprint;
      } else {
        const id = parseUUID(input.templateId);
        if (!id.ok) return domainFailure(invalid('template_id'));
        const ownerId = await owner();
        const row = await queries.getTemplate(ownerId, id.value);
        if (row === null) return notFound(createEntityRef('template', id.value, ownerId));
        const validated = parseTemplateBlueprint(row.document.blueprint);
        if (!validated.ok) return domainFailure(validated);
        blueprint = validated.value;
      }
      const preview = previewTemplateApplication(blueprint, {
        anchorDate: input.anchorDate,
        timeZone: input.timeZone,
        ...(input.selectedKeys === undefined ? {} : { selectedKeys: new Set(input.selectedKeys) }),
      });
      if (!preview.ok) return domainFailure(preview);
      // Overlaps are reported per timed item so the user can decide before applying.
      const { ownerId, profile } = await context();
      const scan = await scanTemplateOverlaps(
        queries,
        ownerId,
        profile.planningTimeZone,
        preview.value,
      );
      return { ok: true, value: { ...preview.value, overlaps: scan.items } };
    },

    async getCapacitySettings() {
      const { ownerId, profile } = await context();
      const constraints = await queries.listCapacityConstraints(ownerId);
      const active = constraints.filter((row) => row.document.state === 'active');
      const dayCap = lowestCap(active, 'day');
      const weekCap = lowestCap(active, 'week');
      return {
        profile,
        availability: active.flatMap((row) => {
          const value = row.document.value;
          if (value.kind !== 'availability') return [];
          return [
            {
              id: row.id,
              localRevision: row.localRevision,
              strength: row.document.strength,
              windows: value.windows,
              ...(row.contextLabel === undefined ? {} : { label: row.contextLabel }),
            },
          ];
        }),
        ...(dayCap === undefined ? {} : { dayCap }),
        ...(weekCap === undefined ? {} : { weekCap }),
        rules: capacityRules(active),
      };
    },

    async listAxes() {
      return queries.listAxes(await owner());
    },

    async listProjects() {
      return queries.listProjects(await owner());
    },
  };
}
