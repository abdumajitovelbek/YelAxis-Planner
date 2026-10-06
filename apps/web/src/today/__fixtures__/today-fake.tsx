/**
 * Test-only fakes and fictional data for Today, focus, Focus mode, and End Day (Today and Focus). Never
 * imported by runtime code.
 */
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';

import type {
  ActionApplication,
  ActionSummary,
  BlockRow,
  EndDayView,
  FocusActionTiming,
  FocusChoices,
  FocusItemView,
  FocusSessionView,
  OccurrenceEntry,
  PlanningApplication,
  ReviewApplication,
  TodayApplication,
  TodayView,
} from '@yelaxis/application';
import {
  createWeekPeriod,
  focusTargetKey,
  type CalendarDate,
  type DayCapacity,
  type UUID,
} from '@yelaxis/domain';

import {
  fakePlanning,
  profile,
  receipt,
  stubActions,
} from '../../plan/__fixtures__/c1-planning-fake';
import { PlanningProvider } from '../../plan/planning-context';
import { ClockContext, type NowSource } from '../clock-context';

/* ───────────────────────── The fake facade ───────────────────────── */

export const todayMethodNames = [
  'getToday',
  'getFocusChoices',
  'getFocusSession',
  'getEndDay',
  'addFocus',
  'removeFocus',
  'reorderFocus',
  'setDayFocus',
  'reorderFlexible',
  'applyEndDay',
] as const satisfies readonly (keyof TodayApplication)[];

type MissingMethod = Exclude<keyof TodayApplication, (typeof todayMethodNames)[number]>;
/** Compile-time proof that the fake lists every Today facade method. */
export const everyTodayMethodListed: [MissingMethod] extends [never] ? true : false = true;

/** Every method present; any call not overridden rejects so accidental calls fail loudly. */
export function fakeToday(overrides: Partial<TodayApplication> = {}): TodayApplication {
  const base = Object.fromEntries(
    todayMethodNames.map((name) => [
      name,
      vi.fn(() => Promise.reject(new Error(`Unexpected today call: ${name}`))),
    ]),
  );
  return { ...base, ...overrides } as TodayApplication;
}

/** Planning facade for Today pages: only Undo answers (the shared runner's default Undo). */
export function todayPlanning(overrides: Partial<PlanningApplication> = {}): PlanningApplication {
  return fakePlanning({ undo: vi.fn(() => Promise.resolve(receipt())), ...overrides });
}

export function TodayLocationProbe(): ReactNode {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

/** A fixed clock for tests: Monday 2026-09-28, 09:00 UTC (the fixture planning zone). */
export const fixedNow: NowSource = () => Date.parse('2026-09-28T09:00:00.000Z');

/**
 * A routed tree with the planning provider (Today included), the injected clock, and a location
 * probe that shows the path and search.
 */
export function todayTree(
  today: TodayApplication,
  element: ReactNode,
  options: {
    readonly path?: string;
    readonly route?: string;
    readonly planning?: PlanningApplication;
    readonly actions?: ActionApplication;
    readonly now?: NowSource;
    readonly extraRoutes?: ReactNode;
    /** The Reviews facade (End Day, the Today review notice); absent unless given. */
    readonly reviews?: ReviewApplication;
  } = {},
): ReactNode {
  return (
    <ClockContext.Provider value={options.now ?? fixedNow}>
      <PlanningProvider
        planning={options.planning ?? todayPlanning()}
        actions={options.actions ?? stubActions}
        today={today}
        reviews={options.reviews ?? null}
      >
        <MemoryRouter initialEntries={[options.path ?? '/']}>
          <Routes>
            <Route path={options.route ?? '/'} element={element} />
            {options.extraRoutes}
            <Route path="*" element={<p>Another page</p>} />
          </Routes>
          <TodayLocationProbe />
        </MemoryRouter>
      </PlanningProvider>
    </ClockContext.Provider>
  );
}

/* ───────────────────────── Fixture data (fictional) ───────────────────────── */

export const todayDate = '2026-09-28' as CalendarDate;
export const todayProfile = profile;

export const todayId = (value: number): UUID =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}` as UUID;

export function todayAction(
  id: UUID,
  title: string,
  extra: Partial<ActionSummary> = {},
): ActionSummary {
  return { id, title, state: 'planned', localRevision: 1, orderKey: '000001000000000', ...extra };
}

export function focusActionItem(
  action: ActionSummary,
  options: {
    readonly position?: number;
    readonly timing?: FocusActionTiming;
    readonly selectionId?: UUID;
  } = {},
): FocusItemView {
  const position = options.position ?? 1;
  return {
    kind: 'action',
    key: focusTargetKey({ kind: 'action', actionId: action.id }),
    target: { kind: 'action', actionId: action.id },
    selectionId: options.selectionId ?? todayId(700 + position),
    localRevision: 1,
    orderKey: String(position * 1_000_000_000).padStart(15, '0'),
    position,
    action,
    timing: options.timing ?? { kind: 'flexible' },
  };
}

export function focusOccurrenceItem(
  occurrence: OccurrenceEntry,
  options: {
    readonly position?: number;
    readonly selectionId?: UUID;
    /** The Routine no longer has this occurrence on the date (or is archived). */
    readonly stale?: boolean;
  } = {},
): FocusItemView {
  const position = options.position ?? 1;
  const ref = occurrence.ref;
  return {
    kind: 'routine_occurrence',
    key: focusTargetKey({ kind: 'routine_occurrence', occurrenceId: ref.occurrenceId }),
    target: {
      kind: 'routine_occurrence',
      occurrence: {
        routineId: ref.routineId,
        generation: ref.generation,
        period: ref.period,
        revision: ref.localRevision ?? 1,
      },
    },
    selectionId: options.selectionId ?? todayId(700 + position),
    localRevision: 1,
    orderKey: String(position * 1_000_000_000).padStart(15, '0'),
    position,
    occurrenceId: ref.occurrenceId,
    routineId: ref.routineId,
    routineTitle: ref.routineTitle,
    routineState: 'active',
    occurrence: options.stale === true ? null : occurrence,
  };
}

/** A scheduled timing for a focus Action with its planned block. */
export const scheduledTiming = (block: BlockRow): FocusActionTiming => ({
  kind: 'scheduled',
  block,
});

const emptyCapacity = (date: CalendarDate): DayCapacity => ({
  date,
  plannedMinutes: 0,
  availability: { status: 'unknown' },
});

/** An intentionally empty live Today; override any part. */
export function todayView(overrides: Partial<TodayView> = {}): TodayView {
  const date = overrides.date ?? todayDate;
  const today = overrides.today ?? todayDate;
  return {
    profile: todayProfile,
    date,
    today,
    relation: date < today ? 'past' : date === today ? 'today' : 'future',
    week: createWeekPeriod(date, todayProfile.weekStart),
    focus: [],
    focusEditable: date >= today,
    timeline: { entries: [], conflicts: [], capacity: emptyCapacity(date), availability: [] },
    flexible: { open: [], done: [] },
    routines: { day: [], week: [] },
    endDayAvailable: date <= today,
    ...overrides,
  };
}

export function focusChoices(overrides: Partial<FocusChoices> = {}): FocusChoices {
  return {
    profile: todayProfile,
    date: todayDate,
    editable: true,
    current: [],
    candidates: [],
    weekTotal: 0,
    ...overrides,
  };
}

export function focusSession(overrides: Partial<FocusSessionView> = {}): FocusSessionView {
  return {
    profile: todayProfile,
    today: todayDate,
    action: todayAction(todayId(1), 'Draft the outline'),
    overdue: false,
    ...overrides,
  };
}

export function endDayView(overrides: Partial<EndDayView> = {}): EndDayView {
  return {
    profile: todayProfile,
    date: todayDate,
    today: todayDate,
    available: true,
    carryTo: '2026-09-29' as CalendarDate,
    completed: [],
    open: { items: [], total: 0 },
    nextFocus: focusChoices({ date: '2026-09-29' as CalendarDate }),
    ...overrides,
  };
}
