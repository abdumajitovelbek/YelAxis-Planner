import { Temporal } from '@js-temporal/polyfill';

import { err, ok, type DomainResult, type EntityId, type Instant } from './contracts.js';
import type { TimeBlock } from './entities.js';
import { createFixedInterval, type FixedInterval, type IanaTimeZone } from './time.js';

/* ───── Constants ───── */

/** Minimum time block duration in minutes. */
export const MIN_BLOCK_MINUTES = 5;
/** Maximum time block duration in minutes (24 hours). */
export const MAX_BLOCK_MINUTES = 1440;

/* ───── Overlap Detection ───── */

/**
 * Represents a detected overlap between a proposed interval and an existing
 * scheduled time block. Resolution is always manual.
 */
export interface TimeBlockConflict {
  readonly conflictingBlockId: EntityId;
  readonly overlapStartsAt: Instant;
  readonly overlapEndsAt: Instant;
}

/** Manual conflict resolution choices. */
export type ConflictResolution = 'move' | 'shorten' | 'keep_overlap' | 'cancel';

/**
 * Pure function: detects overlaps between a proposed interval and a list of
 * existing scheduled blocks. Only `planned` blocks that are not superseded
 * are considered active for overlap purposes.
 */
export const detectTimeBlockOverlaps = (
  interval: FixedInterval,
  existingBlocks: readonly TimeBlock[],
  excludeBlockId?: EntityId,
): readonly TimeBlockConflict[] => {
  const proposedStart = Temporal.Instant.from(interval.startsAt);
  const proposedEnd = Temporal.Instant.from(interval.endsAt);

  const conflicts: TimeBlockConflict[] = [];

  for (const block of existingBlocks) {
    if (block.id === excludeBlockId) continue;
    if (block.state !== 'planned' || block.supersededById !== undefined) continue;

    const blockStart = Temporal.Instant.from(block.interval.startsAt);
    const blockEnd = Temporal.Instant.from(block.interval.endsAt);

    // Two intervals overlap if they share any internal point.
    if (
      Temporal.Instant.compare(proposedStart, blockEnd) < 0 &&
      Temporal.Instant.compare(proposedEnd, blockStart) > 0
    ) {
      const overlapStart =
        Temporal.Instant.compare(proposedStart, blockStart) > 0 ? proposedStart : blockStart;
      const overlapEnd =
        Temporal.Instant.compare(proposedEnd, blockEnd) < 0 ? proposedEnd : blockEnd;
      conflicts.push({
        conflictingBlockId: block.id,
        overlapStartsAt: overlapStart.toString({ smallestUnit: 'millisecond' }) as Instant,
        overlapEndsAt: overlapEnd.toString({ smallestUnit: 'millisecond' }) as Instant,
      });
    }
  }

  return conflicts;
};

/* ───── Interval Validation ───── */

/**
 * Validates and creates a fixed interval suitable for a time block.
 * Enforces min/max duration bounds.
 */
export const validateTimeBlockInterval = (
  startsAt: string,
  endsAt: string,
  timeZone: string,
): DomainResult<FixedInterval> => {
  const parsedStartsAt = parseBlockInstant(startsAt);
  if (!parsedStartsAt.ok) return parsedStartsAt;
  const parsedEndsAt = parseBlockInstant(endsAt);
  if (!parsedEndsAt.ok) return parsedEndsAt;
  const parsedTz = parseBlockTimeZone(timeZone);
  if (!parsedTz.ok) return parsedTz;

  const interval = createFixedInterval(parsedStartsAt.value, parsedEndsAt.value, parsedTz.value);
  if (!interval.ok) return interval;

  const startInstant = Temporal.Instant.from(interval.value.startsAt);
  const endInstant = Temporal.Instant.from(interval.value.endsAt);
  const durationMinutes = Number(
    (endInstant.epochNanoseconds - startInstant.epochNanoseconds) / 60_000_000_000n,
  );

  if (durationMinutes < MIN_BLOCK_MINUTES) {
    return err({
      code: 'invalid_interval',
      message: `A time block must be at least ${MIN_BLOCK_MINUTES} minutes.`,
    });
  }
  if (durationMinutes > MAX_BLOCK_MINUTES) {
    return err({
      code: 'invalid_interval',
      message: `A time block must be at most ${MAX_BLOCK_MINUTES} minutes.`,
    });
  }

  return interval;
};

/* ───── State Transition Validation ───── */

/**
 * Validates a time block state transition. Superseded blocks cannot be mutated.
 * Reopening (back to `planned`) requires explicit `reopen_or_undo` intent.
 */
export const validateTimeBlockTransition = (
  block: TimeBlock,
  targetState: TimeBlock['state'],
  intent?: 'reopen_or_undo',
): DomainResult<void> => {
  if (block.supersededById !== undefined) {
    return err({
      code: 'invalid_transition',
      message: 'Cannot mutate a superseded time block.',
    });
  }

  if (block.state === targetState) {
    return err({
      code: 'invalid_transition',
      message: `Time block is already in state '${targetState}'.`,
    });
  }

  if (block.state === 'canceled' || block.state === 'skipped' || block.state === 'completed') {
    if (targetState !== 'planned') {
      return err({
        code: 'invalid_transition',
        message: `Cannot transition from '${block.state}' to '${targetState}'.`,
      });
    }
    if (intent !== 'reopen_or_undo') {
      return err({
        code: 'invalid_transition',
        message: 'Reopening a resolved time block requires explicit intent.',
      });
    }
  }

  if (block.state === 'planned') {
    if (targetState !== 'completed' && targetState !== 'skipped' && targetState !== 'canceled') {
      return err({
        code: 'invalid_transition',
        message: `Cannot transition a planned block to '${targetState}'.`,
      });
    }
  }

  return ok(undefined);
};

/* ───── Target Validation ───── */

/**
 * Validates that a TimeBlockTarget is well-formed.
 * Re-exports the existing domain validator for consistency.
 */
export { validateTimeBlockTarget } from './entities.js';

/* ───── Helpers ───── */

function parseBlockInstant(value: string): DomainResult<Instant> {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) {
    return err({
      code: 'invalid_time',
      message: 'Time block boundary must be a canonical RFC 3339 UTC instant.',
    });
  }
  try {
    const parsed = Temporal.Instant.from(value);
    return ok(parsed.toString({ smallestUnit: 'millisecond' }) as Instant);
  } catch {
    return err({
      code: 'invalid_time',
      message: 'Time block boundary must be a canonical RFC 3339 UTC instant.',
    });
  }
}

function parseBlockTimeZone(value: string): DomainResult<IanaTimeZone> {
  if (/^[+-]\d{2}:\d{2}$/u.test(value)) {
    return err({
      code: 'invalid_time_zone',
      message: 'Time block time zone must be a valid IANA identifier.',
    });
  }
  try {
    const sample = Temporal.ZonedDateTime.from({
      timeZone: value,
      year: 2000,
      month: 1,
      day: 1,
      hour: 0,
    });
    return ok(sample.timeZoneId as IanaTimeZone);
  } catch {
    return err({
      code: 'invalid_time_zone',
      message: 'Time block time zone must be a valid IANA identifier.',
    });
  }
}
