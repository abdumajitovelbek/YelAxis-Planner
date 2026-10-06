import { Temporal } from '@js-temporal/polyfill';

import type { Instant } from './contracts.js';

/** A planned item with an exact interval that can overlap other planned work. */
export interface TimedPlanItem {
  /** Stable projection key, for example `block:<uuid>` or `occurrence:<logical key>`. */
  readonly key: string;
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  /** The user explicitly accepted that this item may overlap other planned work. */
  readonly overlapAcknowledged: boolean;
}

/**
 * A visible overlap between two planned items. It is resolved only by an explicit manual choice:
 * Move, Shorten, Keep overlap, or Cancel. Nothing is chosen for the user.
 */
export interface ScheduleConflict {
  readonly firstKey: string;
  readonly secondKey: string;
  readonly overlapStartsAt: Instant;
  readonly overlapEndsAt: Instant;
  /** Both items carry an explicit Keep-overlap acknowledgement. */
  readonly kept: boolean;
}

export const conflictResolutionChoices = ['move', 'shorten', 'keep_overlap', 'cancel'] as const;
export type ConflictResolutionChoice = (typeof conflictResolutionChoices)[number];

const compareInstants = (left: Instant, right: Instant): number =>
  Temporal.Instant.compare(left, right);

/**
 * Deterministically lists every overlapping pair once, ordered by the earlier item. Touching
 * intervals (one ends exactly when the next starts) do not conflict.
 */
export const findScheduleConflicts = (
  items: readonly TimedPlanItem[],
): readonly ScheduleConflict[] => {
  const sorted = [...items].sort(
    (left, right) =>
      compareInstants(left.startsAt, right.startsAt) ||
      compareInstants(left.endsAt, right.endsAt) ||
      left.key.localeCompare(right.key),
  );
  const conflicts: ScheduleConflict[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const first = sorted[index];
    if (first === undefined) continue;
    for (let next = index + 1; next < sorted.length; next += 1) {
      const second = sorted[next];
      if (second === undefined) continue;
      if (compareInstants(second.startsAt, first.endsAt) >= 0) break;
      conflicts.push({
        firstKey: first.key,
        secondKey: second.key,
        overlapStartsAt: second.startsAt,
        overlapEndsAt:
          compareInstants(first.endsAt, second.endsAt) <= 0 ? first.endsAt : second.endsAt,
        kept: first.overlapAcknowledged && second.overlapAcknowledged,
      });
    }
  }
  return conflicts;
};
