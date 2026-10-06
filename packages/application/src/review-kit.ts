/**
 * Private helpers shared by the Review modules. The Review kit is the Today kit
 * on the Review query port: the same session (owner, Profile planning preferences, and planning
 * today read in the Profile planning zone), and the same command runner (one `executeCommand` per
 * command, expected revisions, `{ operation }` events with per-record types, a receipt, and a grouped
 * `planning.restore_v1` undo). End Day and focus reads and planners run on it unchanged.
 */
import {
  addDays,
  currentReviewCheckpoint,
  localDateOf,
  previousReviewPeriod,
  reviewDue,
  reviewPeriodContaining,
  sameReviewPeriod,
  type CalendarDate,
  type OwnerId,
  type ReviewPeriod,
  type ReviewType,
  type UUID,
  type WeekPeriod,
} from '@yelaxis/domain';

import type { CanonicalRecordState } from './contracts';
import type { ApplicationDependencies } from './ports';
import type {
  ReviewCheckpoint,
  ReviewDocument,
  ReviewItemDocument,
  ReviewQueryPort,
  ReviewSummary,
} from './review-contracts';
import { createTodayKit, type TodayKit, type TodaySession } from './today-kit';

export interface ReviewKit extends TodayKit {
  readonly queries: ReviewQueryPort;
}

export function createReviewKit(
  dependencies: ApplicationDependencies,
  queries: ReviewQueryPort,
): ReviewKit {
  return { ...createTodayKit(dependencies, queries), queries };
}

/** Owner, Profile planning preferences, and planning today (the Today session). */
export type ReviewSession = TodaySession;

/**
 * Event types of the review's own records. Every decision a Finish applies keeps the
 * normal per-record type (`action.carried`, `focus.added`, `project.transitioned`, and so on).
 * Payloads carry only `{ operation }`.
 */
export const reviewEventTypes = Object.freeze({
  saved: 'review.saved',
  skipped: 'review.skipped',
  finished: 'review.finished',
  itemSaved: 'review_item.saved',
  itemRemoved: 'review_item.removed',
});

type StoredDocument = Readonly<Record<string, unknown>>;

/**
 * Review documents are declared as interfaces (review-contracts), so they convert to and from the
 * canonical record document explicitly. The data codecs validate the stored shape.
 */
export const storedDocument = (document: ReviewDocument | ReviewItemDocument): StoredDocument =>
  document as unknown as StoredDocument;

export const reviewDocumentOf = (record: CanonicalRecordState): ReviewDocument =>
  record.document as unknown as ReviewDocument;

export const reviewItemDocumentOf = (record: CanonicalRecordState): ReviewItemDocument =>
  record.document as unknown as ReviewItemDocument;

/** The states a review can be listed in (never archived). */
export const listedReviewStates: readonly ('draft' | 'skipped' | 'completed')[] = [
  'draft',
  'skipped',
  'completed',
];

/** The Week of a weekly review period, as the planning Horizon reads it. */
export function weekOf(period: ReviewPeriod): WeekPeriod {
  return {
    kind: 'week',
    start: period.start,
    end: period.end,
    weekStart: period.weekStart ?? 'monday',
  };
}

/**
 * The lowest id a record can have, so that listing reviews strictly before (the day after a period
 * starts, this id) includes every review that starts on or before that day and none after it.
 */
const lowestId = '00000000-0000-1000-8000-000000000000' as UUID;

/**
 * The summary of one exact period's review, or null when it has none. It reads the history index:
 * the newest review of the type that starts on or before the period start, kept only when it is
 * that period (one non-archived review exists per exact period).
 */
export async function periodSummary(
  kit: ReviewKit,
  ownerId: OwnerId,
  profileId: UUID,
  period: ReviewPeriod,
): Promise<ReviewSummary | null> {
  const [newest] = await kit.queries.listReviews(ownerId, profileId, {
    type: period.type,
    states: listedReviewStates,
    before: { periodStart: addDays(period.start, 1), id: lowestId },
    limit: 1,
  });
  return newest !== undefined && sameReviewPeriod(newest.period, period) ? newest : null;
}

const isSettled = (summary: ReviewSummary | null): boolean =>
  summary?.state === 'completed' || summary?.state === 'skipped';

/** The one checkpoint offered for a type now (`currentReviewCheckpoint`), with its review. */
export async function checkpointOf(
  kit: ReviewKit,
  session: ReviewSession,
  type: ReviewType,
): Promise<ReviewCheckpoint> {
  const { ownerId, profile, today } = session;
  const current = reviewPeriodContaining(type, today, profile.weekStart);
  const previous = previousReviewPeriod(current);
  const startedOn =
    profile.createdAt === undefined
      ? undefined
      : localDateOf(profile.createdAt, profile.planningTimeZone);
  // On a period's last day the previous period no longer matters, and a period that ended before
  // the Profile existed is never offered, so neither is read.
  const previousSummary =
    today === current.end || (startedOn !== undefined && previous.end < startedOn)
      ? null
      : await periodSummary(kit, ownerId, profile.profileId, previous);
  const period = currentReviewCheckpoint({
    type,
    today,
    weekStart: profile.weekStart,
    previousSettled: isSettled(previousSummary),
    ...(startedOn === undefined ? {} : { startedOn }),
  });
  const summary = sameReviewPeriod(period, previous)
    ? previousSummary
    : await periodSummary(kit, ownerId, profile.profileId, period);
  return checkpoint(period, today, summary);
}

function checkpoint(
  period: ReviewPeriod,
  today: CalendarDate,
  summary: ReviewSummary | null,
): ReviewCheckpoint {
  return {
    period,
    due: reviewDue(period, today),
    status: summary?.state ?? 'not_started',
    ...(summary === null ? {} : { review: summary }),
  };
}
