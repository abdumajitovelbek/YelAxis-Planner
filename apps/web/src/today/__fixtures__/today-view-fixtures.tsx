/**
 * Test-only fictional data for the Today view (Today and Focus Part 1): a populated day on the fixture's
 * live today (Monday 2026-09-28, UTC planning zone). Never imported by runtime code.
 */
import type {
  ActionApplication,
  ActionSummary,
  BlockRow,
  CapacitySettings,
  ConflictView,
  OccurrenceEntry,
  TimedEntry,
  TodayView,
} from '@yelaxis/application';
import type { CalendarDate, DayCapacity, Instant, WallTime } from '@yelaxis/domain';

import { occurrence } from '../../plan/__fixtures__/c1-planning-fake';
import { todayAction, todayDate, todayId, todayProfile, todayView } from './today-fake';

const at = (day: string, time: string): Instant => `${day}T${time}:00.000Z` as Instant;

/** Capacity settings whose Profile zone is the fixture zone (the page waits for it). */
export const todaySettings: CapacitySettings = {
  profile: todayProfile,
  availability: [],
  rules: { windows: [], caps: [] },
};

/** A Day-placed flexible Action with the placement a reorder names. */
export function flexibleAction(
  value: number,
  title: string,
  extra: Partial<ActionSummary> = {},
): ActionSummary {
  return todayAction(todayId(value), title, {
    localRevision: 3,
    placement: {
      id: todayId(value + 100),
      localRevision: 2,
      period: { kind: 'day', date: todayDate },
    },
    ...extra,
  });
}

export const callBank = flexibleAction(1, 'Call the bank', { estimateMinutes: 15 });
export const readArticle = flexibleAction(2, 'Read article', { state: 'in_progress' });
export const sendInvoice = flexibleAction(3, 'Send invoice', { state: 'completed' });

function block(value: number, target: BlockRow['target'], start: string, end: string): BlockRow {
  return {
    id: todayId(value),
    localRevision: 2,
    startsAt: at(todayDate, start),
    endsAt: at(todayDate, end),
    timeZone: todayProfile.planningTimeZone,
    state: 'planned',
    overlapAcknowledged: false,
    target,
  };
}

function entry(input: {
  readonly key: string;
  readonly kind: TimedEntry['kind'];
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly block?: BlockRow;
  readonly occurrence?: OccurrenceEntry;
  readonly conflictsWith?: readonly string[];
}): TimedEntry {
  return {
    key: input.key,
    kind: input.kind,
    title: input.title,
    startsAt: at(todayDate, input.start),
    endsAt: at(todayDate, input.end),
    timeZone: todayProfile.planningTimeZone,
    localDate: todayDate,
    localStart: input.start as WallTime,
    localEndDate: todayDate,
    localEnd: input.end as WallTime,
    durationMinutes:
      (Date.parse(at(todayDate, input.end)) - Date.parse(at(todayDate, input.start))) / 60000,
    state: 'planned',
    overlapAcknowledged: false,
    conflictsWith: input.conflictsWith ?? [],
    ...(input.block === undefined ? {} : { block: input.block }),
    ...(input.occurrence === undefined ? {} : { occurrence: input.occurrence }),
  };
}

export const reportBlock = block(
  10,
  {
    kind: 'action',
    actionId: todayId(4),
    title: 'Write report',
    actionState: 'scheduled',
    actionRevision: 4,
  },
  '14:00',
  '15:00',
);
export const reportEntry = entry({
  key: `block:${reportBlock.id}`,
  kind: 'action_block',
  title: 'Write report',
  start: '14:00',
  end: '15:00',
  block: reportBlock,
  conflictsWith: [`block:${todayId(11)}`],
});
export const dentistEntry = entry({
  key: `block:${todayId(11)}`,
  kind: 'commitment_block',
  title: 'Dentist',
  start: '14:30',
  end: '15:30',
  block: block(
    11,
    {
      kind: 'commitment',
      commitmentId: todayId(12),
      title: 'Dentist',
      strength: 'hard',
      commitmentState: 'planned',
      commitmentRevision: 1,
    },
    '14:30',
    '15:30',
  ),
  conflictsWith: [reportEntry.key],
});
export const overlap: ConflictView = {
  firstKey: reportEntry.key,
  secondKey: dentistEntry.key,
  overlapStartsAt: at(todayDate, '14:30'),
  overlapEndsAt: at(todayDate, '15:00'),
  kept: false,
  first: reportEntry,
  second: dentistEntry,
};

export const stretch = occurrence({
  occurrenceId: todayId(20),
  routineId: todayId(21),
  title: 'Stretch',
  day: todayDate,
  timing: { kind: 'flexible' },
});
export const swim = occurrence({
  occurrenceId: todayId(22),
  routineId: todayId(23),
  title: 'Swim',
  timing: { kind: 'weekly_count' },
  weekly: { target: 2, done: 1 },
});

export const capacityUnknown: DayCapacity = {
  date: todayDate,
  plannedMinutes: 120,
  availability: { status: 'unknown' },
};

/** A day with timed work, an overlap, flexible Actions (open and done), and Routines. */
export function populatedView(overrides: Partial<TodayView> = {}): TodayView {
  return todayView({
    timeline: {
      entries: [reportEntry, dentistEntry],
      conflicts: [overlap],
      capacity: capacityUnknown,
      availability: [],
    },
    flexible: { open: [callBank, readArticle], done: [sendInvoice] },
    routines: { day: [stretch], week: [swim] },
    ...overrides,
  });
}

export const nextDay = '2026-09-29' as CalendarDate;

/** An Actions facade where only the given methods answer; any other call rejects loudly. */
export function fakeActions(overrides: Partial<ActionApplication>): ActionApplication {
  return new Proxy(overrides, {
    get: (target, key) =>
      (target as Record<PropertyKey, unknown>)[key] ??
      (() => Promise.reject(new Error(`Unexpected Action call: ${String(key)}`))),
  }) as ActionApplication;
}
