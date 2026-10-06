/**
 * Test-only fakes and fictional data for Reviews (Review). Never imported by runtime code. The fixture
 * planning today is Wednesday 2026-09-30 in the UTC fixture zone, with weeks starting on Monday.
 */
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi, type Mock } from 'vitest';

import type {
  ActionSummary,
  ApplicationResult,
  Bounded,
  CommandReceipt,
  EndDayView,
  FocusChoices,
  MonthlyReviewContext,
  PlanningApplication,
  ReminderView,
  ReviewApplication,
  ReviewAxisRow,
  ReviewCheckpoint,
  ReviewCommitmentCandidate,
  ReviewItemTargetView,
  ReviewObjectRow,
  ReviewOverview,
  ReviewProjectRow,
  ReviewSummary,
  ReviewView,
  SavedReview,
  SavedReviewItem,
  WeekSelectionRow,
  WeeklyReviewContext,
  YearlyReviewContext,
} from '@yelaxis/application';
import {
  parseReviewPeriodKey,
  type CalendarDate,
  type Instant,
  type ReviewDecisionKind,
  type ReviewDue,
  type ReviewPeriod,
  type ReviewStatus,
  type ReviewType,
  type UUID,
  type WallTime,
} from '@yelaxis/domain';

import {
  fakePlanning,
  LocationProbe,
  profile,
  receipt,
  stubActions,
  weekPlan,
} from '../../plan/__fixtures__/c1-planning-fake';
import { PlanningProvider } from '../../plan/planning-context';

/* ───────────────────────── The fake facade ───────────────────────── */

export const reviewMethodNames = [
  'getOverview',
  'listHistory',
  'getReview',
  'getNotice',
  'saveReview',
  'skipReview',
  'finishReview',
  'setReviewReminder',
  'turnOffReviewReminder',
] as const satisfies readonly (keyof ReviewApplication)[];

type MissingMethod = Exclude<keyof ReviewApplication, (typeof reviewMethodNames)[number]>;
/** Compile-time proof that the fake lists every Review facade method. */
export const everyReviewMethodListed: [MissingMethod] extends [never] ? true : false = true;

/** Every method present; any call not overridden rejects so accidental calls fail loudly. */
export function fakeReviews(overrides: Partial<ReviewApplication> = {}): ReviewApplication {
  const base = Object.fromEntries(
    reviewMethodNames.map((name) => [
      name,
      vi.fn(() => Promise.reject(new Error(`Unexpected review call: ${name}`))),
    ]),
  );
  return { ...base, ...overrides } as ReviewApplication;
}

/** Planning facade for review pages: Undo and the planning Week answer. */
export function reviewPlanning(overrides: Partial<PlanningApplication> = {}): PlanningApplication {
  return fakePlanning({
    undo: vi.fn(() => Promise.resolve(receipt('undo-2'))),
    getWeekPlan: vi.fn(() => Promise.resolve(weekPlan())),
    ...overrides,
  });
}

/** A routed tree with the planning provider (Reviews included) and a location probe. */
export function reviewTree(
  reviews: ReviewApplication,
  element: ReactNode,
  options: {
    readonly path?: string;
    readonly route?: string;
    readonly planning?: PlanningApplication;
    readonly extraRoutes?: ReactNode;
  } = {},
): ReactNode {
  return (
    <PlanningProvider
      planning={options.planning ?? reviewPlanning()}
      actions={stubActions}
      reviews={reviews}
    >
      <MemoryRouter initialEntries={[options.path ?? '/review']}>
        <Routes>
          <Route path={options.route ?? '/review'} element={element} />
          {options.extraRoutes}
          <Route path="*" element={<p>Another page</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </PlanningProvider>
  );
}

/* ───────────────────────── Fixture data (fictional) ───────────────────────── */

export const reviewToday = '2026-09-30' as CalendarDate;
export const reviewProfile = profile;

export const reviewId = (value: number): UUID =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}` as UUID;

/** The exact period of a type and key, as the domain parses it. */
export function reviewPeriod(type: ReviewType, key: string): ReviewPeriod {
  const parsed = parseReviewPeriodKey(type, key);
  if (!parsed.ok) throw new Error(`Invalid fixture period ${type} ${key}`);
  return parsed.value;
}

export const bounded = <T,>(items: readonly T[], total = items.length): Bounded<T> => ({
  items,
  total,
});

const at = (value: string): Instant => value as Instant;

export function reviewSummary(
  period: ReviewPeriod,
  overrides: Partial<ReviewSummary> = {},
): ReviewSummary {
  return {
    reviewId: reviewId(500),
    localRevision: 2,
    period,
    state: 'draft',
    decisionCount: 0,
    updatedAt: at('2026-09-29T20:00:00.000Z'),
    ...overrides,
  };
}

export function reviewCheckpoint(
  period: ReviewPeriod,
  due: ReviewDue,
  status: ReviewStatus,
  review?: ReviewSummary,
): ReviewCheckpoint {
  return { period, due, status, ...(review === undefined ? {} : { review }) };
}

export const dailyPeriod = reviewPeriod('daily', reviewToday);
export const weeklyPeriod = reviewPeriod('weekly', '2026-09-21');
export const currentWeekPeriod = reviewPeriod('weekly', '2026-09-28');
export const monthlyPeriod = reviewPeriod('monthly', '2026-09');
export const yearlyPeriod = reviewPeriod('yearly', '2026');

/** Daily due today, weekly ended (a draft), monthly due today, yearly not due; nothing else. */
export function reviewOverview(overrides: Partial<ReviewOverview> = {}): ReviewOverview {
  return {
    profile: reviewProfile,
    today: reviewToday,
    checkpoints: [
      reviewCheckpoint(dailyPeriod, 'due', 'not_started'),
      reviewCheckpoint(
        weeklyPeriod,
        'ended',
        'draft',
        reviewSummary(weeklyPeriod, { reviewId: reviewId(501) }),
      ),
      reviewCheckpoint(monthlyPeriod, 'due', 'not_started'),
      reviewCheckpoint(yearlyPeriod, 'not_due', 'not_started'),
    ],
    inProgress: bounded([]),
    ...overrides,
  };
}

/* ───────────── Saved reviews ───────────── */

let nextItem = 600;

export function savedItem(
  target: ReviewItemTargetView,
  decision: ReviewDecisionKind,
  overrides: Partial<SavedReviewItem> = {},
): SavedReviewItem {
  nextItem += 1;
  return {
    itemId: reviewId(nextItem),
    localRevision: 1,
    target,
    decision,
    position: 1,
    ...overrides,
  };
}

export function savedReview(overrides: Partial<SavedReview> = {}): SavedReview {
  return {
    reviewId: reviewId(501),
    localRevision: 3,
    state: 'draft',
    items: [],
    createdAt: at('2026-09-28T18:00:00.000Z'),
    updatedAt: at('2026-09-29T20:00:00.000Z'),
    ...overrides,
  };
}

/** A scheduled "Remind me to finish" reminder at a date and time in the UTC fixture zone. */
export function reminderView(
  date: string,
  time: string,
  overrides: Partial<ReminderView> = {},
): ReminderView {
  return {
    reminderId: reviewId(950),
    localRevision: 1,
    kind: 'at',
    remindAt: at(`${date}T${time}:00.000Z`),
    timeZone: reviewProfile.planningTimeZone,
    date: date as CalendarDate,
    time: time as WallTime,
    ...overrides,
  };
}

/** The saved review once its reminder is turned off: the read shows no reminder. */
export function withoutReminder(saved: SavedReview): SavedReview {
  return Object.fromEntries(
    Object.entries(saved).filter(([key]) => key !== 'reminder'),
  ) as unknown as SavedReview;
}

/**
 * Stateful reminder commands for a fake that keeps one saved review, like the application: set and
 * turn off change only its reminder (never its revision), and each returns its own undo id.
 */
export function fakeReminderCommands(store: {
  readonly get: () => SavedReview | null;
  readonly change: (next: SavedReview, undoId: string) => ApplicationResult<CommandReceipt>;
}): {
  readonly setReviewReminder: Mock<ReviewApplication['setReviewReminder']>;
  readonly turnOffReviewReminder: Mock<ReviewApplication['turnOffReviewReminder']>;
} {
  return {
    setReviewReminder: vi.fn<ReviewApplication['setReviewReminder']>((input) => {
      const saved = store.get();
      if (saved === null) throw new Error('No saved review to remind about.');
      const current = saved.reminder;
      return Promise.resolve(
        store.change(
          {
            ...saved,
            reminder: reminderView(input.reminder.date, input.reminder.time, {
              localRevision: (current?.localRevision ?? 0) + 1,
            }),
          },
          'undo-reminder',
        ),
      );
    }),
    turnOffReviewReminder: vi.fn<ReviewApplication['turnOffReviewReminder']>(() => {
      const saved = store.get();
      if (saved === null) throw new Error('No saved review to remind about.');
      return Promise.resolve(store.change(withoutReminder(saved), 'undo-reminder-off'));
    }),
  };
}

/* ───────────── Weekly ───────────── */

export function reviewAction(
  value: number,
  title: string,
  extra: Partial<ActionSummary> = {},
): ActionSummary {
  return {
    id: reviewId(value),
    title,
    state: 'planned',
    localRevision: 2,
    orderKey: '000001000000000',
    ...extra,
  };
}

export const invoice = reviewAction(1, 'Send the invoice', { state: 'completed' });
export const outline = reviewAction(2, 'Draft the outline');
export const venue = reviewAction(3, 'Call the venue', { state: 'inbox' });
export const brief = reviewAction(4, 'Write the brief');

export const health: ReviewAxisRow = { id: reviewId(21), title: 'Health', color: 'emerald' };
export const work: ReviewAxisRow = { id: reviewId(22), title: 'Work' };

export function objectRow(
  kind: ReviewObjectRow['kind'],
  value: number,
  title: string,
  extra: Partial<ReviewObjectRow> = {},
): ReviewObjectRow {
  return { kind, id: reviewId(value), localRevision: 4, title, state: 'active', ...extra };
}

export const course: ReviewProjectRow = {
  ...objectRow('project', 31, 'Launch the course', { context: 'Work' }),
  kind: 'project',
  nextAction: { id: brief.id, title: brief.title },
};
export const shed: ReviewProjectRow = {
  ...objectRow('project', 32, 'Build the shed', { state: 'blocked', localRevision: 7 }),
  kind: 'project',
};

export const planningWeek = {
  kind: 'week',
  start: '2026-09-28' as CalendarDate,
  end: '2026-10-04' as CalendarDate,
  weekStart: 'monday',
} as const;

export function weekSelection(
  value: number,
  target: WeekSelectionRow['target'],
  orderKey = 'a0',
): WeekSelectionRow {
  return { id: reviewId(value), localRevision: 1, period: planningWeek, orderKey, target };
}

export function commitmentCandidate(
  kind: ReviewCommitmentCandidate['kind'],
  value: number,
  title: string,
  selected = false,
  state = 'active',
): ReviewCommitmentCandidate {
  return { kind, id: reviewId(value), title, state, selected };
}

export const betaReady = commitmentCandidate('milestone', 41, 'Beta ready');

export function firstDayChoices(overrides: Partial<FocusChoices> = {}): FocusChoices {
  return {
    profile: reviewProfile,
    date: reviewToday,
    editable: true,
    current: [],
    candidates: [
      {
        kind: 'action',
        key: `action:${outline.id}`,
        target: { kind: 'action', actionId: outline.id },
        source: 'week',
        action: outline,
        selected: false,
      },
      {
        kind: 'action',
        key: `action:${brief.id}`,
        target: { kind: 'action', actionId: brief.id },
        source: 'week',
        action: brief,
        selected: false,
      },
    ],
    weekTotal: 2,
    ...overrides,
  } as FocusChoices;
}

export function weeklyContext(overrides: Partial<WeeklyReviewContext> = {}): WeeklyReviewContext {
  return {
    done: bounded([invoice]),
    open: bounded([outline, venue]),
    routines: { completed: 4, skipped: 1 },
    inboxCount: 3,
    projects: bounded([course, shed]),
    axes: bounded([health, work]),
    planningWeek,
    commitments: [
      weekSelection(51, { kind: 'action', id: outline.id, title: outline.title, state: 'planned' }),
    ],
    commitmentCandidates: bounded([
      commitmentCandidate('action', 2, outline.title, true, 'planned'),
      commitmentCandidate('action', 4, brief.title, false, 'planned'),
      commitmentCandidate('project', 31, course.title),
      commitmentCandidate('project', 32, shed.title, false, 'blocked'),
      betaReady,
    ]),
    firstDayFocus: firstDayChoices(),
    ...overrides,
  };
}

type DailyView = Extract<ReviewView, { readonly type: 'daily' }>;
type WeeklyView = Extract<ReviewView, { readonly type: 'weekly' }>;
type MonthlyView = Extract<ReviewView, { readonly type: 'monthly' }>;
type YearlyView = Extract<ReviewView, { readonly type: 'yearly' }>;

const viewBase = {
  profile: reviewProfile,
  today: reviewToday,
  reviewable: true,
  aligned: true,
  saved: null,
  editable: true,
} as const;

/** The weekly review of September 21–27, reviewed on Wednesday September 30: nothing saved yet. */
export function weeklyView(overrides: Partial<WeeklyView> = {}): WeeklyView {
  return {
    ...viewBase,
    type: 'weekly',
    period: weeklyPeriod,
    due: 'ended',
    currentCheckpoint: weeklyPeriod,
    planning: currentWeekPeriod,
    context: weeklyContext(),
    ...overrides,
  };
}

/* ───────────── Daily ───────────── */

/** The daily review of an End Day view: editable until it is finished, like the application. */
export function dailyReviewView(
  endDay: EndDayView,
  saved: SavedReview | null,
  overrides: Partial<DailyView> = {},
): DailyView {
  const completed = saved?.state === 'completed';
  const editable = endDay.available && !completed;
  return {
    type: 'daily',
    profile: endDay.profile,
    today: endDay.today,
    period: reviewPeriod('daily', endDay.date),
    due: endDay.date === endDay.today ? 'due' : endDay.date < endDay.today ? 'ended' : 'not_due',
    reviewable: endDay.available,
    aligned: true,
    currentCheckpoint: reviewPeriod('daily', endDay.today),
    ...(endDay.available ? { planning: reviewPeriod('daily', endDay.carryTo) } : {}),
    saved,
    editable,
    context: editable ? { endDay } : null,
    ...overrides,
  };
}

/* ───────────── Monthly ───────────── */

export const halfMarathon = objectRow('outcome', 61, 'Run a half marathon', { context: 'Health' });
export const pausedOutcome = objectRow('outcome', 62, 'Learn the cello', {
  state: 'paused',
  context: 'Joy',
});
export const firstRace = objectRow('milestone', 63, 'First 10 km race', {
  context: 'Run a half marathon',
  targetEnd: '2026-10-18' as CalendarDate,
});
export const pausedProject = objectRow('project', 64, 'Photo album', { state: 'paused' });

export function monthlyContext(
  overrides: Partial<MonthlyReviewContext> = {},
): MonthlyReviewContext {
  return {
    outcomes: bounded([halfMarathon, pausedOutcome]),
    milestones: bounded([firstRace]),
    projects: bounded([objectRow('project', 31, 'Launch the course'), pausedProject]),
    planningMonth: '2026-10' as MonthlyReviewContext['planningMonth'],
    theme: 'Steady training',
    ...overrides,
  };
}

/** The same month with no theme set. */
export function monthlyContextWithoutTheme(): MonthlyReviewContext {
  const { milestones, outcomes, planningMonth, projects } = monthlyContext();
  return { outcomes, milestones, projects, planningMonth };
}

/** The monthly review of September 2026, due today. */
export function monthlyView(overrides: Partial<MonthlyView> = {}): MonthlyView {
  return {
    ...viewBase,
    type: 'monthly',
    period: monthlyPeriod,
    due: 'due',
    currentCheckpoint: monthlyPeriod,
    planning: reviewPeriod('monthly', '2026-10'),
    context: monthlyContext(),
    ...overrides,
  };
}

/* ───────────── Yearly ───────────── */

export function yearlyContext(overrides: Partial<YearlyReviewContext> = {}): YearlyReviewContext {
  return {
    outcomes: bounded([halfMarathon]),
    reviewedDirection: 'Build a calm, healthy rhythm.',
    planningYear: '2027' as YearlyReviewContext['planningYear'],
    ...overrides,
  };
}

/** The same year with no direction written. */
export function yearlyContextWithoutDirection(): YearlyReviewContext {
  const { outcomes, planningYear } = yearlyContext();
  return { outcomes, planningYear };
}

/** The yearly review of 2026, started early. */
export function yearlyView(overrides: Partial<YearlyView> = {}): YearlyView {
  return {
    ...viewBase,
    type: 'yearly',
    period: yearlyPeriod,
    due: 'not_due',
    currentCheckpoint: yearlyPeriod,
    planning: reviewPeriod('yearly', '2027'),
    context: yearlyContext(),
    ...overrides,
  };
}
