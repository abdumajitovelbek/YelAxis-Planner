import { describe, expect, it } from 'vitest';

import type { EntityId, Instant, OwnerId } from './contracts';
import type { TimeBlock } from './entities';
import type { FixedInterval, IanaTimeZone } from './time';
import {
  detectTimeBlockOverlaps,
  MAX_BLOCK_MINUTES,
  MIN_BLOCK_MINUTES,
  validateTimeBlockInterval,
  validateTimeBlockTransition,
} from './time-blocks';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const blockId1 = '20000000-0000-4000-8000-000000000001' as EntityId;
const blockId2 = '20000000-0000-4000-8000-000000000002' as EntityId;
const blockId3 = '20000000-0000-4000-8000-000000000003' as EntityId;
const tz = 'America/New_York' as IanaTimeZone;
const now = '2026-08-01T12:00:00.000Z' as Instant;

function makeBlock(
  overrides: Partial<TimeBlock> & { id: EntityId; interval: FixedInterval },
): TimeBlock {
  return {
    ownerId,
    localRevision: 1,
    createdAt: now,
    updatedAt: now,
    target: { kind: 'custom', title: 'Test' },
    state: 'planned',
    ...overrides,
  };
}

describe('validateTimeBlockInterval', () => {
  it('accepts a valid 30-minute interval', () => {
    const result = validateTimeBlockInterval(
      '2026-08-01T09:00:00.000Z',
      '2026-08-01T09:30:00.000Z',
      'America/New_York',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.startsAt).toBe('2026-08-01T09:00:00.000Z');
      expect(result.value.endsAt).toBe('2026-08-01T09:30:00.000Z');
    }
  });

  it('rejects interval shorter than minimum', () => {
    const result = validateTimeBlockInterval(
      '2026-08-01T09:00:00.000Z',
      '2026-08-01T09:04:00.000Z',
      'America/New_York',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_interval');
  });

  it('rejects interval longer than maximum', () => {
    const result = validateTimeBlockInterval(
      '2026-08-01T00:00:00.000Z',
      '2026-08-02T00:01:00.000Z',
      'America/New_York',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_interval');
  });

  it('rejects interval where end is before start', () => {
    const result = validateTimeBlockInterval(
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T09:00:00.000Z',
      'America/New_York',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_interval');
  });

  it('rejects an invalid IANA time zone', () => {
    const result = validateTimeBlockInterval(
      '2026-08-01T09:00:00.000Z',
      '2026-08-01T10:00:00.000Z',
      'Invalid/Zone',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_time_zone');
  });

  it('rejects a UTC offset instead of IANA zone', () => {
    const result = validateTimeBlockInterval(
      '2026-08-01T09:00:00.000Z',
      '2026-08-01T10:00:00.000Z',
      '-05:00',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_time_zone');
  });

  it('rejects a non-RFC-3339 instant', () => {
    const result = validateTimeBlockInterval(
      '2026-08-01 09:00:00',
      '2026-08-01T10:00:00.000Z',
      'America/New_York',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_time');
  });

  it(`accepts exactly ${MIN_BLOCK_MINUTES} minute block`, () => {
    const result = validateTimeBlockInterval(
      '2026-08-01T09:00:00.000Z',
      '2026-08-01T09:05:00.000Z',
      'America/New_York',
    );
    expect(result.ok).toBe(true);
  });

  it(`accepts exactly ${MAX_BLOCK_MINUTES} minute block`, () => {
    const result = validateTimeBlockInterval(
      '2026-08-01T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
      'America/New_York',
    );
    expect(result.ok).toBe(true);
  });
});

describe('detectTimeBlockOverlaps', () => {
  const existing: readonly TimeBlock[] = [
    makeBlock({
      id: blockId1,
      interval: {
        startsAt: '2026-08-01T09:00:00.000Z' as Instant,
        endsAt: '2026-08-01T10:00:00.000Z' as Instant,
        timeZone: tz,
      },
    }),
    makeBlock({
      id: blockId2,
      interval: {
        startsAt: '2026-08-01T14:00:00.000Z' as Instant,
        endsAt: '2026-08-01T15:00:00.000Z' as Instant,
        timeZone: tz,
      },
    }),
    makeBlock({
      id: blockId3,
      interval: {
        startsAt: '2026-08-01T10:00:00.000Z' as Instant,
        endsAt: '2026-08-01T11:00:00.000Z' as Instant,
        timeZone: tz,
      },
      state: 'canceled',
    }),
  ];

  it('returns empty when no overlap', () => {
    const result = detectTimeBlockOverlaps(
      {
        startsAt: '2026-08-01T11:00:00.000Z' as Instant,
        endsAt: '2026-08-01T12:00:00.000Z' as Instant,
        timeZone: tz,
      },
      existing,
    );
    expect(result).toEqual([]);
  });

  it('detects overlap with a single block', () => {
    const result = detectTimeBlockOverlaps(
      {
        startsAt: '2026-08-01T09:30:00.000Z' as Instant,
        endsAt: '2026-08-01T10:30:00.000Z' as Instant,
        timeZone: tz,
      },
      existing,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.conflictingBlockId).toBe(blockId1);
  });

  it('ignores canceled blocks', () => {
    const result = detectTimeBlockOverlaps(
      {
        startsAt: '2026-08-01T10:00:00.000Z' as Instant,
        endsAt: '2026-08-01T11:00:00.000Z' as Instant,
        timeZone: tz,
      },
      existing,
    );
    expect(result).toEqual([]);
  });

  it('ignores superseded blocks', () => {
    const superseded = [
      makeBlock({
        id: blockId1,
        interval: {
          startsAt: '2026-08-01T09:00:00.000Z' as Instant,
          endsAt: '2026-08-01T10:00:00.000Z' as Instant,
          timeZone: tz,
        },
        supersededById: blockId2,
        state: 'canceled',
      }),
    ];
    const result = detectTimeBlockOverlaps(
      {
        startsAt: '2026-08-01T09:00:00.000Z' as Instant,
        endsAt: '2026-08-01T10:00:00.000Z' as Instant,
        timeZone: tz,
      },
      superseded,
    );
    expect(result).toEqual([]);
  });

  it('excludes specified block ID from overlap check', () => {
    const result = detectTimeBlockOverlaps(
      {
        startsAt: '2026-08-01T09:00:00.000Z' as Instant,
        endsAt: '2026-08-01T10:00:00.000Z' as Instant,
        timeZone: tz,
      },
      existing,
      blockId1,
    );
    expect(result).toEqual([]);
  });

  it('detects overlaps with multiple blocks', () => {
    const result = detectTimeBlockOverlaps(
      {
        startsAt: '2026-08-01T08:00:00.000Z' as Instant,
        endsAt: '2026-08-01T15:00:00.000Z' as Instant,
        timeZone: tz,
      },
      existing,
    );
    expect(result).toHaveLength(2);
  });

  it('does not detect adjacent (touching) blocks as overlapping', () => {
    const result = detectTimeBlockOverlaps(
      {
        startsAt: '2026-08-01T10:00:00.000Z' as Instant,
        endsAt: '2026-08-01T14:00:00.000Z' as Instant,
        timeZone: tz,
      },
      existing,
    );
    expect(result).toEqual([]);
  });
});

describe('validateTimeBlockTransition', () => {
  const planned = makeBlock({
    id: blockId1,
    interval: {
      startsAt: '2026-08-01T09:00:00.000Z' as Instant,
      endsAt: '2026-08-01T10:00:00.000Z' as Instant,
      timeZone: tz,
    },
  });

  it('allows planned → completed', () => {
    expect(validateTimeBlockTransition(planned, 'completed').ok).toBe(true);
  });

  it('allows planned → skipped', () => {
    expect(validateTimeBlockTransition(planned, 'skipped').ok).toBe(true);
  });

  it('allows planned → canceled', () => {
    expect(validateTimeBlockTransition(planned, 'canceled').ok).toBe(true);
  });

  it('rejects same-state transition', () => {
    const result = validateTimeBlockTransition(planned, 'planned');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_transition');
  });

  it('rejects completed → planned without explicit intent', () => {
    const completed = { ...planned, state: 'completed' as const };
    const result = validateTimeBlockTransition(completed, 'planned');
    expect(result.ok).toBe(false);
  });

  it('allows completed → planned with reopen intent', () => {
    const completed = { ...planned, state: 'completed' as const };
    const result = validateTimeBlockTransition(completed, 'planned', 'reopen_or_undo');
    expect(result.ok).toBe(true);
  });

  it('rejects mutation of superseded block', () => {
    const superseded = { ...planned, supersededById: blockId2 };
    const result = validateTimeBlockTransition(superseded, 'completed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_transition');
  });

  it('rejects canceled → completed (must go through planned)', () => {
    const canceled = { ...planned, state: 'canceled' as const };
    const result = validateTimeBlockTransition(canceled, 'completed');
    expect(result.ok).toBe(false);
  });
});
