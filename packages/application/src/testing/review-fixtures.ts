/**
 * Test-only fixture for the Review application tests: an in-memory harness, the Review query
 * fake, seeders for the plan and for alignment objects and reviews, the facade, and small helpers
 * that read committed records and prove that a refused command wrote nothing.
 *
 * Planning today is Wednesday 2026-09-30 in New York, and weeks start on Monday, unless a test
 * passes another clock or Profile.
 */
import {
  entityRefKey,
  type CommandId,
  type EntityRef,
  type EntityType,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from '../contracts';
import type { PlanProfile } from '../planning-contracts';
import { createPlanningApplication } from '../planning';
import { createTestPlanningQueries } from '../planning-routines-test-queries';
import type { ReviewApplication } from '../review-contracts';
import { createReviewApplication } from '../reviews';
import { createInMemoryHarness, type InMemoryHarness } from './in-memory-unit-of-work';
import {
  createReviewSeeder,
  createReviewTestQueries,
  type ReviewSeeder,
  type ReviewTestQueries,
} from './review-test-queries';
import { createTodaySeeder, type TodaySeeder } from './today-test-queries';

type Doc = Readonly<Record<string, unknown>>;

export const reviewOwnerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
export const reviewZone = 'America/New_York' as IanaTimeZone;
/** Wednesday 2026-09-30, 09:00 in New York. */
export const reviewNow = '2026-09-30T13:00:00.000Z' as Instant;
export const reviewProfile: PlanProfile = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: reviewZone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};

export interface ReviewFixture {
  readonly harness: InMemoryHarness;
  readonly queries: ReviewTestQueries;
  readonly reviews: ReviewApplication;
  /** Actions, placements, blocks, Routines, occurrences, and day focus. */
  readonly plan: TodaySeeder;
  /** Axes, Outcomes, Milestones, Projects, themes, directions, commitments, and reviews. */
  readonly seed: ReviewSeeder;
  /** A facade that reads the Profile with these changes; the records are shared. */
  reviewsFor(changes: Partial<PlanProfile>): ReviewApplication;
  /** Apply a receipt's grouped undo with `PlanningApplication.undo`. */
  undo(receipt: CommandReceipt): Promise<ApplicationResult<CommandReceipt>>;
  /** The committed document of a record now. */
  document(record: CanonicalRecordState | EntityRef): Doc | undefined;
  revision(record: CanonicalRecordState | EntityRef): number | undefined;
  /** Every committed record of a type. */
  records(type: EntityType): CanonicalRecordState[];
  /** Every audit event as [event type, payload], in order. */
  events(): (readonly [string, Readonly<Record<string, unknown>>])[];
  /** Run a command that must be refused; prove it wrote nothing, and return its reason. */
  refusedWithoutWrites(run: () => Promise<ApplicationResult<CommandReceipt>>): Promise<unknown>;
}

const refOf = (record: CanonicalRecordState | EntityRef): EntityRef =>
  'ref' in record ? record.ref : record;

export function createReviewFixture(
  now: Instant = reviewNow,
  profile: PlanProfile = reviewProfile,
): ReviewFixture {
  const harness = createInMemoryHarness(reviewOwnerId, now);
  const queries = createReviewTestQueries(harness.unitOfWork, profile);
  const current = (record: CanonicalRecordState | EntityRef) =>
    harness.unitOfWork.get(entityRefKey(refOf(record)));
  return {
    harness,
    queries,
    reviews: createReviewApplication(harness.dependencies, queries),
    plan: createTodaySeeder(harness.unitOfWork, reviewOwnerId, profile),
    seed: createReviewSeeder(harness.unitOfWork, reviewOwnerId, profile),
    reviewsFor: (changes) =>
      createReviewApplication(
        harness.dependencies,
        createReviewTestQueries(harness.unitOfWork, { ...profile, ...changes }),
      ),
    undo(receipt) {
      if (!receipt.undo.available) throw new Error('No undo.');
      return createPlanningApplication(
        harness.dependencies,
        createTestPlanningQueries(harness.unitOfWork, profile),
      ).undo(receipt.undo.undoId);
    },
    document: (record) => current(record)?.document,
    revision: (record) => current(record)?.localRevision,
    records: (type) =>
      [...harness.unitOfWork.state.records.values()].filter((record) => record.ref.type === type),
    events: () =>
      harness.unitOfWork.state.events.map(({ event }) => [event.eventType, event.payload] as const),
    async refusedWithoutWrites(run) {
      const snapshot = (): string => {
        const state = harness.unitOfWork.state;
        return JSON.stringify([
          [...state.records.entries()],
          state.events.length,
          state.undo.length,
          state.receipts.size,
          state.outbox.length,
        ]);
      };
      const before = snapshot();
      const result = await run();
      if (snapshot() !== before) throw new Error('A refused command wrote something.');
      return rejection(result);
    },
  };
}

export function accepted(result: ApplicationResult<CommandReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** A refusal's domain reason (or domain code), or the application error code. */
export function rejection(result: ApplicationResult<CommandReceipt>): unknown {
  if (result.ok) throw new Error('Expected a rejection.');
  if (result.error.code !== 'domain_rejected') return result.error.code;
  return result.error.domainError.details?.['reason'] ?? result.error.domainError.code;
}

/** A refusal's message, for checking calm wording. */
export function refusalMessage(result: ApplicationResult<CommandReceipt>): string {
  if (result.ok || result.error.code !== 'domain_rejected') throw new Error('Expected a refusal.');
  return result.error.domainError.message;
}

export const commandId = (value: number): CommandId =>
  `c0000000-0000-4000-8000-${String(value).padStart(12, '0')}` as CommandId;
