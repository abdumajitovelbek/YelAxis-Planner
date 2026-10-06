/**
 * Test-only fakes for the Plan shell, Week, and Day views. Never imported by runtime code.
 */
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';

import type {
  ActionApplication,
  ActionSummary,
  ApplicationResult,
  BlockRow,
  CommandReceipt,
  ConflictView,
  DayColumn,
  DayPlan,
  OccurrenceEntry,
  PlanProfile,
  PlanningApplication,
  TimedEntry,
  WeekPlan,
} from '@yelaxis/application';
import type {
  CalendarDate,
  CommandId,
  DayCapacity,
  IanaTimeZone,
  Instant,
  OwnerId,
  RoutineOccurrenceKey,
  UUID,
  WallTime,
  Weekday,
} from '@yelaxis/domain';

import { PlanningProvider } from '../planning-context';

const methodNames = [
  'getDayPlan',
  'getWeekPlan',
  'getMonthPlan',
  'getYearPlan',
  'getMilestoneChain',
  'resolveLocalInterval',
  'listRoutines',
  'getRoutine',
  'previewRoutine',
  'listTemplates',
  'getTemplate',
  'previewTemplate',
  'getCapacitySettings',
  'listAxes',
  'listProjects',
  'createCustomBlock',
  'scheduleAction',
  'moveBlock',
  'shortenBlock',
  'setBlockState',
  'keepOverlap',
  'createCommitment',
  'place',
  'unplace',
  'carryForward',
  'reorderPlacement',
  'addWeekCommitment',
  'removeWeekCommitment',
  'createRoutine',
  'repeatAfterAction',
  'editRoutineDetails',
  'editRoutineThisAndFuture',
  'pauseRoutine',
  'resumeRoutine',
  'archiveRoutine',
  'restoreRoutine',
  'completeOccurrence',
  'skipOccurrence',
  'reopenOccurrence',
  'editOccurrence',
  'applyTemplate',
  'duplicateTemplate',
  'saveTemplate',
  'archiveTemplate',
  'restoreTemplate',
  'saveWeekAsTemplate',
  'addAvailability',
  'editAvailability',
  'archiveConstraint',
  'setCapacityCap',
  'setMonthTheme',
  'clearMonthTheme',
  'setYearDirection',
  'clearYearDirection',
  'previewPlanningZoneChange',
  'changePlanningZone',
  'getTimeBlockReminder',
  'setTimeBlockReminder',
  'turnOffTimeBlockReminder',
  'setRoutineReminder',
  'turnOffRoutineReminder',
  'undo',
] as const satisfies readonly (keyof PlanningApplication)[];

type MissingMethod = Exclude<keyof PlanningApplication, (typeof methodNames)[number]>;
/** Compile-time proof that the fake lists every facade method. */
export const everyMethodListed: [MissingMethod] extends [never] ? true : false = true;

/** Every method present; unused ones reject so accidental calls fail loudly. */
export function fakePlanning(overrides: Partial<PlanningApplication> = {}): PlanningApplication {
  const base = Object.fromEntries(
    methodNames.map((name) => [
      name,
      vi.fn(() => Promise.reject(new Error(`Unexpected planning call: ${name}`))),
    ]),
  );
  return { ...base, ...overrides } as PlanningApplication;
}

export const stubActions = new Proxy(
  {},
  { get: () => () => Promise.reject(new Error('Unexpected Action call')) },
) as ActionApplication;

export function receipt(undoId = 'undo-1'): ApplicationResult<CommandReceipt> {
  return {
    ok: true,
    value: {
      commandId: 'command-1' as CommandId,
      ownerId: 'owner-1' as OwnerId,
      actor: 'user',
      acceptedAt: '2026-09-29T08:00:00.000Z' as Instant,
      canonical: [],
      eventIds: [],
      undo: { available: true, undoId: undoId as UUID },
      sync: { queued: false },
    },
  };
}

export function LocationProbe(): ReactNode {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

export function renderTree(
  planning: PlanningApplication,
  element: ReactNode,
  path = '/',
  route = '/',
): ReactNode {
  return (
    <PlanningProvider planning={planning} actions={stubActions}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </PlanningProvider>
  );
}

/** jsdom lacks the native dialog methods used by the shared Modal. */
export function installDialogPolyfill(): void {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
}

/* ───────────────────────── Fixture data (fictional) ───────────────────────── */

export const id = (value: string): UUID => value as UUID;
const date = (value: string): CalendarDate => value as CalendarDate;
const wall = (value: string): WallTime => value as WallTime;
const instant = (day: string, time: string): Instant => `${day}T${time}:00.000Z` as Instant;

export const profile: PlanProfile = {
  profileId: id('profile-1'),
  planningTimeZone: 'UTC' as IanaTimeZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};

export const weekDates = [
  '2026-09-28',
  '2026-09-29',
  '2026-09-30',
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
] as const;
const weekdays: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export function action(
  actionId: string,
  title: string,
  extra: Partial<ActionSummary> = {},
): ActionSummary {
  return {
    id: id(actionId),
    title,
    state: 'planned',
    localRevision: 3,
    orderKey: 'a0',
    ...extra,
  };
}

function entry(input: {
  readonly key: string;
  readonly kind: TimedEntry['kind'];
  readonly title: string;
  readonly day: string;
  readonly start: string;
  readonly end: string;
  readonly endDay?: string;
  readonly conflictsWith?: readonly string[];
  readonly kept?: boolean;
  readonly state?: TimedEntry['state'];
  readonly block?: BlockRow;
  readonly occurrence?: OccurrenceEntry;
}): TimedEntry {
  const endDay = input.endDay ?? input.day;
  const startsAt = instant(input.day, input.start);
  const endsAt = instant(endDay, input.end);
  return {
    key: input.key,
    kind: input.kind,
    title: input.title,
    startsAt,
    endsAt,
    timeZone: profile.planningTimeZone,
    localDate: date(input.day),
    localStart: wall(input.start),
    localEndDate: date(endDay),
    localEnd: wall(input.end),
    durationMinutes: Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60000),
    state: input.state ?? 'planned',
    overlapAcknowledged: input.kept ?? false,
    conflictsWith: input.conflictsWith ?? [],
    ...(input.block === undefined ? {} : { block: input.block }),
    ...(input.occurrence === undefined ? {} : { occurrence: input.occurrence }),
  };
}

function block(
  blockId: string,
  target: BlockRow['target'],
  day: string,
  start: string,
  end: string,
  kept = false,
): BlockRow {
  return {
    id: id(blockId),
    localRevision: 2,
    startsAt: instant(day, start),
    endsAt: instant(day, end),
    timeZone: profile.planningTimeZone,
    state: 'planned',
    overlapAcknowledged: kept,
    target,
  };
}

export function occurrence(input: {
  readonly occurrenceId: string;
  readonly routineId: string;
  readonly title: string;
  readonly day?: string;
  readonly timing: OccurrenceEntry['timing'];
  readonly state?: OccurrenceEntry['state'];
  readonly weekly?: { readonly target: number; readonly done: number };
  readonly revision?: number;
}): OccurrenceEntry {
  const period: OccurrenceEntry['ref']['period'] =
    input.weekly === undefined
      ? { kind: 'date', date: date(input.day ?? weekDates[0]) }
      : {
          kind: 'week',
          start: date(weekDates[0]),
          end: date(weekDates[6]),
          weekStart: 'monday',
          targetCount: input.weekly.target,
        };
  return {
    ref: {
      routineId: id(input.routineId),
      routineTitle: input.title,
      occurrenceId: id(input.occurrenceId),
      logicalKey: `key-${input.occurrenceId}` as RoutineOccurrenceKey,
      generation: 1,
      period,
      materialized: input.revision !== undefined,
      ...(input.revision === undefined ? {} : { localRevision: input.revision }),
    },
    state: input.state ?? 'planned',
    ...(input.day === undefined ? {} : { date: date(input.day) }),
    moved: false,
    timing: input.timing,
    ...(input.weekly === undefined
      ? {}
      : { targetCount: input.weekly.target, completedCount: input.weekly.done }),
  };
}

export const dentistBlock = block(
  'block-dentist',
  {
    kind: 'commitment',
    commitmentId: id('commitment-1'),
    title: 'Dentist',
    strength: 'hard',
    commitmentState: 'planned',
    commitmentRevision: 1,
  },
  '2026-09-29',
  '09:00',
  '10:00',
);
export const reportBlock = block(
  'block-report',
  {
    kind: 'action',
    actionId: id('action-report'),
    title: 'Write report',
    actionState: 'scheduled',
    actionRevision: 4,
  },
  '2026-09-29',
  '09:30',
  '11:00',
);
const gymBlock = block(
  'block-gym',
  { kind: 'custom', title: 'Gym' },
  '2026-09-30',
  '18:00',
  '19:00',
  true,
);

export const dentist = entry({
  key: 'block:block-dentist',
  kind: 'commitment_block',
  title: 'Dentist',
  day: '2026-09-29',
  start: '09:00',
  end: '10:00',
  conflictsWith: ['block:block-report'],
  block: dentistBlock,
});
export const report = entry({
  key: 'block:block-report',
  kind: 'action_block',
  title: 'Write report',
  day: '2026-09-29',
  start: '09:30',
  end: '11:00',
  conflictsWith: ['block:block-dentist'],
  block: reportBlock,
});
const walkOccurrence = occurrence({
  occurrenceId: 'occ-walk',
  routineId: 'routine-walk',
  title: 'Evening walk',
  day: '2026-09-30',
  timing: {
    kind: 'timed',
    startsAt: instant('2026-09-30', '18:30'),
    endsAt: instant('2026-09-30', '19:00'),
  },
  revision: 5,
});
const gym = entry({
  key: 'block:block-gym',
  kind: 'custom_block',
  title: 'Gym',
  day: '2026-09-30',
  start: '18:00',
  end: '19:00',
  conflictsWith: ['occurrence:occ-walk'],
  kept: true,
  block: gymBlock,
});
const walk = entry({
  key: 'occurrence:occ-walk',
  kind: 'routine_occurrence',
  title: 'Evening walk',
  day: '2026-09-30',
  start: '18:30',
  end: '19:00',
  conflictsWith: ['block:block-gym'],
  kept: true,
  occurrence: walkOccurrence,
});
export const lateShift = entry({
  key: 'block:block-late',
  kind: 'custom_block',
  title: 'Night shift',
  day: '2026-10-02',
  start: '22:00',
  end: '02:00',
  endDay: '2026-10-03',
  block: block(
    'block-late',
    { kind: 'custom', title: 'Night shift' },
    '2026-10-02',
    '22:00',
    '23:59',
  ),
});

export const openConflict: ConflictView = {
  firstKey: dentist.key,
  secondKey: report.key,
  overlapStartsAt: instant('2026-09-29', '09:30'),
  overlapEndsAt: instant('2026-09-29', '10:00'),
  kept: false,
  first: dentist,
  second: report,
};
const keptConflict: ConflictView = {
  firstKey: gym.key,
  secondKey: walk.key,
  overlapStartsAt: instant('2026-09-30', '18:30'),
  overlapEndsAt: instant('2026-09-30', '19:00'),
  kept: true,
  first: gym,
  second: walk,
};

const unknownDay = (day: string, planned = 0): DayCapacity => ({
  date: date(day),
  plannedMinutes: planned,
  availability: { status: 'unknown' },
});

export const stretch = occurrence({
  occurrenceId: 'occ-stretch',
  routineId: 'routine-stretch',
  title: 'Stretch',
  day: '2026-10-01',
  timing: { kind: 'flexible' },
});
export const swim = occurrence({
  occurrenceId: 'occ-swim',
  routineId: 'routine-swim',
  title: 'Swim',
  timing: { kind: 'weekly_count' },
  weekly: { target: 2, done: 1 },
});
export const callBank = action('action-bank', 'Call the bank', {
  placement: {
    id: id('placement-bank'),
    localRevision: 1,
    period: { kind: 'day', date: date('2026-09-28') },
  },
});
export const readArticle = action('action-read', 'Read article', { estimateMinutes: 30 });
export const planTrip = action('action-trip', 'Plan trip');
export const oldTask = action('action-old', 'Old task', {
  placement: {
    id: id('placement-old'),
    localRevision: 2,
    period: { kind: 'day', date: date('2026-09-25') },
  },
});
export const draftPlan = action('action-draft', 'Draft plan');

function column(day: string, index: number): DayColumn {
  const base: DayColumn = {
    date: date(day),
    weekday: weekdays[index] ?? 'monday',
    capacity: unknownDay(day),
    availability: [],
    timed: [],
    flexibleActions: [],
    flexibleOccurrences: [],
  };
  switch (day) {
    case '2026-09-28':
      return { ...base, flexibleActions: [callBank] };
    case '2026-09-29':
      return {
        ...base,
        capacity: {
          date: date(day),
          plannedMinutes: 150,
          availability: { status: 'known', minutes: 480, basis: 'windows' },
        },
        availability: [{ start: wall('09:00'), end: wall('17:00') }],
        timed: [dentist, report],
      };
    case '2026-09-30':
      return { ...base, capacity: unknownDay(day, 90), timed: [gym, walk] };
    case '2026-10-01':
      return { ...base, flexibleOccurrences: [stretch] };
    case '2026-10-02':
      return { ...base, timed: [lateShift] };
    case '2026-10-03':
      return { ...base, timed: [lateShift] };
    default:
      return base;
  }
}

export function weekPlan(overrides: Partial<WeekPlan> = {}): WeekPlan {
  const days = weekDates.map((day, index) => column(day, index));
  return {
    profile,
    today: date('2026-09-29'),
    week: { kind: 'week', start: date(weekDates[0]), end: date(weekDates[6]), weekStart: 'monday' },
    capacity: {
      range: { start: date(weekDates[0]), end: date(weekDates[6]) },
      plannedMinutes: 480,
      availability: { status: 'partial', knownMinutes: 480, knownDays: 1, totalDays: 7 },
      days: days.map((day) => day.capacity),
    },
    days,
    fixed: [dentist],
    conflicts: [openConflict, keptConflict],
    carryForward: { items: [oldTask, draftPlan], total: 2 },
    weekActions: [planTrip],
    weekObjects: [
      {
        id: id('placement-milestone'),
        localRevision: 1,
        period: {
          kind: 'week',
          start: date(weekDates[0]),
          end: date(weekDates[6]),
          weekStart: 'monday',
        },
        orderKey: 'a0',
        target: {
          kind: 'milestone',
          id: id('milestone-1'),
          title: 'Beta ready',
          state: 'active',
          localRevision: 2,
          outcomeId: id('outcome-1'),
          outcomeTitle: 'Launch',
        },
      },
    ],
    weekCommitments: ['One', 'Two', 'Three', 'Four'].map((title, index) => ({
      id: id(`selection-${String(index)}`),
      localRevision: 1,
      period: {
        kind: 'week',
        start: date(weekDates[0]),
        end: date(weekDates[6]),
        weekStart: 'monday',
      },
      orderKey: `a${String(index)}`,
      target: { kind: 'action', id: id(`commit-${String(index)}`), title, state: 'planned' },
    })),
    weeklyCounts: [swim],
    backlog: { items: [readArticle], total: 3 },
    ...overrides,
  };
}

export function dayPlan(overrides: Partial<DayPlan> = {}): DayPlan {
  const week = weekPlan();
  const tuesday = week.days[1];
  if (tuesday === undefined) throw new Error('fixture');
  return {
    profile,
    today: date('2026-09-29'),
    day: { ...tuesday, flexibleActions: [callBank], flexibleOccurrences: [stretch] },
    week: week.week,
    conflicts: [openConflict],
    weeklyCounts: [swim],
    backlog: { items: [readArticle, planTrip], total: 2 },
    ...overrides,
  };
}
