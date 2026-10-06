import { Temporal } from '@js-temporal/polyfill';

import { err, ok, type DomainResult, type Instant } from './contracts.js';
import { isInputRecord } from './input-record.js';
import {
  energyLabels,
  type EnergyLabel,
  type Priority,
  type ReminderSchedule,
} from './entities.js';
import {
  resolveFloatingDateTime,
  type CalendarDate,
  type DstGapPolicy,
  type DstOverlapPolicy,
  type IanaTimeZone,
  type WallTime,
} from './time.js';

export const actionFieldLimits = Object.freeze({
  title: 200,
  note: 10_000,
  estimateMinutes: 10_080,
});

export interface ActionFieldInput {
  readonly title: string;
  readonly note?: string;
  readonly estimateMinutes?: number;
  readonly energy?: string;
  readonly priority?: string;
}

export interface NormalizedActionFields {
  readonly title: string;
  readonly note?: string;
  readonly estimateMinutes?: number;
  readonly energy?: EnergyLabel;
  readonly priority?: Priority;
}

const invalid = (reason: string): DomainResult<never> =>
  err({
    code: 'invalid_value',
    message: 'The Action fields are not valid.',
    details: { reason },
  });

export function normalizeActionInput(
  input: ActionFieldInput,
): DomainResult<NormalizedActionFields> {
  if (
    !isInputRecord(input, ['title', 'note', 'estimateMinutes', 'energy', 'priority']) ||
    typeof input.title !== 'string' ||
    (input.note !== undefined && typeof input.note !== 'string')
  )
    return invalid('input_shape');
  const title = input.title.trim();
  const note = input.note?.trim();
  if (title.length === 0) return invalid('title_required');
  if (title.length > actionFieldLimits.title) return invalid('title_too_long');
  if (note !== undefined && note.length > actionFieldLimits.note) return invalid('note_too_long');
  if (
    input.estimateMinutes !== undefined &&
    (!Number.isSafeInteger(input.estimateMinutes) ||
      input.estimateMinutes < 1 ||
      input.estimateMinutes > actionFieldLimits.estimateMinutes)
  ) {
    return invalid('estimate_minutes');
  }
  if (input.energy !== undefined && !energyLabels.includes(input.energy as EnergyLabel)) {
    return invalid('energy');
  }
  if (
    input.priority !== undefined &&
    !(['low', 'normal', 'high'] as const).includes(input.priority as Priority)
  ) {
    return invalid('priority');
  }
  return ok({
    title,
    ...(note === undefined || note.length === 0 ? {} : { note }),
    ...(input.estimateMinutes === undefined ? {} : { estimateMinutes: input.estimateMinutes }),
    ...(input.energy === undefined ? {} : { energy: input.energy as EnergyLabel }),
    ...(input.priority === undefined ? {} : { priority: input.priority as Priority }),
  });
}

const ORDER_MIDDLE = 500_000_000_000_000;
const ORDER_MAX = 999_999_999_999_999;
const ORDER_WIDTH = 15;

export function createInboxOrderKey(
  edge?: string,
  direction: 'after' | 'before' = 'before',
): DomainResult<string> {
  if (edge === undefined) return ok(String(ORDER_MIDDLE).padStart(ORDER_WIDTH, '0'));
  if (!/^\d{15}$/u.test(edge)) return invalid('order_key');
  const current = Number(edge);
  const next = current + (direction === 'before' ? -1 : 1);
  if (!Number.isSafeInteger(next) || next < 0 || next > ORDER_MAX) {
    return invalid('order_key_exhausted');
  }
  return ok(String(next).padStart(ORDER_WIDTH, '0'));
}

export type ActionReminderInput =
  | Readonly<{
      kind: 'at';
      date: CalendarDate;
      wallTime: WallTime | string;
      timeZone: IanaTimeZone;
      gapPolicy: DstGapPolicy;
      overlapPolicy: DstOverlapPolicy;
    }>
  | Readonly<{
      kind: 'relative';
      anchor: Instant;
      offsetMinutes: number;
      timeZone: IanaTimeZone;
    }>;

export function resolveActionReminder(input: ActionReminderInput): DomainResult<ReminderSchedule> {
  if (input.kind === 'at') {
    const resolved = resolveFloatingDateTime({
      date: input.date,
      wallTime: input.wallTime as WallTime,
      timeZone: input.timeZone,
      gapPolicy: input.gapPolicy,
      overlapPolicy: input.overlapPolicy,
    });
    if (!resolved.ok) return resolved;
    if (resolved.value === null) return invalid('reminder_time_skipped');
    return ok({ kind: 'at', remindAt: resolved.value, timeZone: input.timeZone });
  }
  if (
    !Number.isSafeInteger(input.offsetMinutes) ||
    input.offsetMinutes < 0 ||
    input.offsetMinutes > actionFieldLimits.estimateMinutes
  ) {
    return invalid('reminder_offset');
  }
  const remindAt = Temporal.Instant.from(input.anchor)
    .subtract({ minutes: input.offsetMinutes })
    .toString({ smallestUnit: 'millisecond' }) as Instant;
  return ok({
    kind: 'relative',
    remindAt,
    // Canonical schedules use signed offsets: negative is before the anchor.
    offsetMinutes: -input.offsetMinutes,
    timeZone: input.timeZone,
  });
}
