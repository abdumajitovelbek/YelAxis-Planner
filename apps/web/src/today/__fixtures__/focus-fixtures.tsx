/**
 * Test-only fixtures for the focus strip, choosing focus, and Focus mode (Today and Focus Part 2). Fictional
 * data only; never imported by runtime code.
 */
import type { ReactNode } from 'react';
import { vi, type MockInstance } from 'vitest';

import type {
  ActionApplication,
  ActionSummary,
  BlockRow,
  FocusCandidate,
  OccurrenceEntry,
  PlanProfile,
  TimedEntry,
} from '@yelaxis/application';
import {
  focusTargetKey,
  type CalendarDate,
  type Instant,
  type UUID,
  type WallTime,
} from '@yelaxis/domain';

import { occurrence, receipt } from '../../plan/__fixtures__/c1-planning-fake';
import { CommandFeedback, useCommandRunner, type CommandRunner } from '../../plan/planning-context';
import { todayDate, todayId, todayProfile } from './today-fake';

/** A 12-hour profile in UTC, so times read like "2:00 PM". */
export const twelveHourProfile: PlanProfile = { ...todayProfile, timeFormat: '12_hour' };

/** An Action facade whose methods reject unless overridden (transition and undo answer). */
export function focusActions(overrides: Partial<ActionApplication> = {}): ActionApplication {
  const base = {
    transition: vi.fn(() => Promise.resolve(receipt('undo-action'))),
    undo: vi.fn(() => Promise.resolve(receipt('undo-back'))),
  };
  return new Proxy(
    { ...base, ...overrides },
    {
      get: (target, name: string) =>
        name in target
          ? (target as Record<string, unknown>)[name]
          : () => Promise.reject(new Error(`Unexpected Action call: ${name}`)),
    },
  ) as ActionApplication;
}

const at = (date: string, time: string): Instant => `${date}T${time}:00.000Z` as Instant;

/** A planned Action block on the fixture date (UTC) and its timeline entry. */
export function scheduledEntry(
  action: ActionSummary,
  start: string,
  end: string,
  date: string = todayDate,
): { readonly block: BlockRow; readonly entry: TimedEntry } {
  const block: BlockRow = {
    id: todayId(900 + Number(start.slice(0, 2))),
    localRevision: 2,
    startsAt: at(date, start),
    endsAt: at(date, end),
    timeZone: todayProfile.planningTimeZone,
    state: 'planned',
    overlapAcknowledged: false,
    target: {
      kind: 'action',
      actionId: action.id,
      title: action.title,
      actionState: action.state,
      actionRevision: action.localRevision,
    },
  };
  const entry: TimedEntry = {
    key: `block:${block.id}`,
    kind: 'action_block',
    title: action.title,
    startsAt: block.startsAt,
    endsAt: block.endsAt,
    timeZone: block.timeZone,
    localDate: date as CalendarDate,
    localStart: start as WallTime,
    localEndDate: date as CalendarDate,
    localEnd: end as WallTime,
    durationMinutes: Math.round((Date.parse(block.endsAt) - Date.parse(block.startsAt)) / 60_000),
    state: 'planned',
    overlapAcknowledged: false,
    conflictsWith: [],
    block,
  };
  return { block, entry };
}

/** A flexible dated Routine Occurrence on the fixture date. */
export function dayOccurrence(
  title: string,
  number: number,
  options: { readonly state?: OccurrenceEntry['state']; readonly revision?: number } = {},
): OccurrenceEntry {
  return occurrence({
    occurrenceId: todayId(500 + number),
    routineId: todayId(600 + number),
    title,
    day: todayDate,
    timing: { kind: 'flexible' },
    ...(options.state === undefined ? {} : { state: options.state }),
    ...(options.revision === undefined ? {} : { revision: options.revision }),
  });
}

/** A weekly-count Routine Occurrence for the fixture week. */
export function weeklyOccurrence(title: string, done: number, target: number): OccurrenceEntry {
  return occurrence({
    occurrenceId: todayId(591),
    routineId: todayId(691),
    title,
    timing: { kind: 'weekly_count' },
    weekly: { target, done },
    revision: 1,
  });
}

export function actionCandidate(
  action: ActionSummary,
  source: 'scheduled' | 'flexible' | 'week',
  options: { readonly block?: BlockRow; readonly selected?: boolean } = {},
): FocusCandidate {
  return {
    kind: 'action',
    key: focusTargetKey({ kind: 'action', actionId: action.id }),
    target: { kind: 'action', actionId: action.id },
    source,
    action,
    ...(options.block === undefined ? {} : { block: options.block }),
    selected: options.selected ?? false,
  };
}

export function occurrenceCandidate(entry: OccurrenceEntry, selected = false): FocusCandidate {
  const ref = entry.ref;
  return {
    kind: 'routine_occurrence',
    key: focusTargetKey({ kind: 'routine_occurrence', occurrenceId: ref.occurrenceId }),
    target: {
      kind: 'routine_occurrence',
      occurrence: {
        routineId: ref.routineId,
        generation: ref.generation,
        period: ref.period,
        ...(ref.localRevision === undefined ? {} : { revision: ref.localRevision }),
      },
    },
    source: 'routine',
    occurrence: entry,
    selected,
  };
}

/** Renders `children(runner)` with one shared runner and its feedback (announcement, Undo). */
export function WithRunner({
  children,
}: {
  readonly children: (runner: CommandRunner) => ReactNode;
}): ReactNode {
  const runner = useCommandRunner();
  return (
    <>
      {children(runner)}
      <CommandFeedback runner={runner} />
    </>
  );
}

export const fictionalId = (value: number): UUID => todayId(value);

/**
 * A fake facade's method as its mock, read by name so a test never detaches a method signature
 * from its object (the unbound-method lint rule).
 */
export function mockOf<T extends object>(fake: T, name: keyof T & string): MockInstance {
  const method = (fake as Record<string, unknown>)[name];
  if (!vi.isMockFunction(method)) throw new Error(`${name} is not a mock.`);
  return method;
}
