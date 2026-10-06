import type { CalendarDate, ReviewPeriod, ReviewType } from '@yelaxis/domain';

import { oneOf, text, weekdayValues, type Values } from './planning-queries';

export const reviewTypeValues: readonly ReviewType[] = ['daily', 'weekly', 'monthly', 'yearly'];

/**
 * The exact period of one `review_checkpoints` row read as `review_type`, `period_key`,
 * `period_start_date`, `period_end_date`, and `week_start` (weekly only). Shared by the review
 * read model and the Axis recent review note, so neither imports the other.
 */
export function reviewPeriodFromRow(row: Values): ReviewPeriod {
  const type = oneOf(row, 'review_type', reviewTypeValues);
  return {
    type,
    key: text(row, 'period_key'),
    start: text(row, 'period_start_date') as CalendarDate,
    end: text(row, 'period_end_date') as CalendarDate,
    ...(type === 'weekly' ? { weekStart: oneOf(row, 'week_start', weekdayValues) } : {}),
  };
}
