import { message as uiMessage } from '../messages';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { ConflictView } from '@yelaxis/application';
import type { DayCapacity, WeekCapacity } from '@yelaxis/domain';

import { capacitySummary, formatShortDuration } from './format';
import { capacityPath } from './routes';

/**
 * Short, neutral capacity line for one day. Unknown availability is never described as free time
 * and nothing is expressed as a score or percentage.
 */
export function shortDayCapacity(capacity: DayCapacity): string {
  const planned = uiMessage('plan.capacity-summary.1208', {
    value0: formatShortDuration(capacity.plannedMinutes),
  });
  if (capacity.availability.status === 'unknown')
    return uiMessage('plan.capacity-summary.1209', { value0: planned });
  const over =
    capacity.overByMinutes === undefined
      ? ''
      : uiMessage('plan.capacity-summary.1210', {
          value0: formatShortDuration(capacity.overByMinutes),
        });
  return uiMessage('plan.capacity-summary.1211', {
    value0: planned,
    value1: formatShortDuration(capacity.availability.minutes),
    value2: over,
  });
}

/** Guidance paragraph for a Day or Week, with a link to define available time when unknown. */
export function CapacitySummary({
  capacity,
}: {
  readonly capacity: DayCapacity | WeekCapacity;
}): ReactNode {
  const unknown = capacity.availability.status !== 'known';
  return (
    <p className="capacity-summary">
      <span>{capacitySummary(capacity)}</span>
      {unknown && (
        <>
          {' '}
          <Link to={capacityPath}>{uiMessage('plan.capacity-summary.1212')}</Link>
        </>
      )}
    </p>
  );
}

export function conflictCounts(conflicts: readonly ConflictView[]): {
  readonly open: number;
  readonly kept: number;
} {
  const kept = conflicts.filter((conflict) => conflict.kept).length;
  return { open: conflicts.length - kept, kept };
}

/** Neutral overlap count, e.g. "2 overlaps to review · 1 overlap kept". */
export function conflictCountText(conflicts: readonly ConflictView[]): string {
  const { open, kept } = conflictCounts(conflicts);
  const parts: string[] = [];
  if (open === 0) parts.push(uiMessage('plan.capacity-summary.1213'));
  else
    parts.push(
      uiMessage('plan.capacity-summary.1214', {
        value0: String(open),
        value1: open === 1 ? 'overlap' : 'overlaps',
      }),
    );
  if (kept > 0)
    parts.push(
      uiMessage('plan.capacity-summary.1215', {
        value0: String(kept),
        value1: kept === 1 ? 'overlap' : 'overlaps',
      }),
    );
  return parts.join(' · ');
}

export function ConflictCount({
  conflicts,
}: {
  readonly conflicts: readonly ConflictView[];
}): ReactNode {
  const { open } = conflictCounts(conflicts);
  return (
    <p className={open > 0 ? 'conflict-count warning-text' : 'conflict-count'}>
      {open > 0 ? <a href="#plan-overlaps">{conflictCountText(conflicts)}</a> : null}
      {open === 0 ? conflictCountText(conflicts) : null}
    </p>
  );
}
