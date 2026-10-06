/**
 * Test-only Review query port over the in-memory unit of work, plus a small fixture seeder. It wraps
 * the Today and planning test queries and follows the port's documented semantics closely enough for
 * application tests: owner scoping, non-archived reviews only, (period start, id) history order
 * with a strict `before` bound, active items in (order key, id) order, and bounded lists. Reads see
 * every committed record. Row timestamps come from the review's audit events (the in-memory store
 * keeps none). It never writes, and it logs every call with its arguments.
 */
import {
  compareOrder,
  createEntityRef,
  entityRefKey,
  occurrenceLogicalKey,
  projectNextAction,
  reviewLimits,
  routineOccurrenceId,
  type CalendarDate,
  type EntityType,
  type Instant,
  type OwnerId,
  type ReviewPeriod,
  type UUID,
} from '@yelaxis/domain';

import type { ActionCanonicalDocument } from '../actions';
import type { Bounded } from '../alignment-contracts';
import type { CanonicalRecordState } from '../contracts';
import type {
  AxisDocument,
  FocusSelectionDocument,
  MilestoneDocument,
  MonthThemeDocument,
  OutcomeDocument,
  PlanProfile,
  ProjectDocument,
  RoutineDocument,
  WeekSelectionRow,
  YearDirectionDocument,
} from '../planning-contracts';
import { createTestPlanningQueries } from '../planning-routines-test-queries';
import type {
  ReviewAxisRow,
  ReviewDocument,
  ReviewItemDocument,
  ReviewItemRow,
  ReviewItemTargetView,
  ReviewObjectRow,
  ReviewProjectRow,
  ReviewQueryPort,
  ReviewSummary,
} from '../review-contracts';
import type { InMemoryUnitOfWork } from './in-memory-unit-of-work';
import { createTodayTestQueries } from './today-test-queries';

type Doc = Readonly<Record<string, unknown>>;

export interface ReviewQueryCall {
  readonly method: keyof ReviewQueryPort;
  readonly args: readonly unknown[];
}

export interface ReviewTestQueries extends ReviewQueryPort {
  /** Every Review-specific port call in order, with its arguments. */
  readonly calls: ReviewQueryCall[];
}

const maxLimit = 200;
/** Timestamp of a seeded review that has no audit event. */
const seededAt = '2026-01-01T00:00:00.000Z' as Instant;

const clampLimit = (limit: number): number =>
  Number.isFinite(limit) ? Math.max(0, Math.min(Math.trunc(limit), maxLimit)) : maxLimit;

const bounded = <T>(items: readonly T[], limit: number): Bounded<T> => ({
  items: items.slice(0, clampLimit(limit)),
  total: items.length,
});

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Code-unit order, as SQLite compares TEXT (locale collation would put `~` before digits). */
const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const isArchived = (document: Doc): boolean =>
  document['state'] === 'archived' || document['archivedAt'] !== undefined;

const byOrder = (left: CanonicalRecordState, right: CanonicalRecordState): number =>
  compareOrder(
    { id: left.ref.id, orderKey: text(left.document['orderKey']) ?? '' },
    { id: right.ref.id, orderKey: text(right.document['orderKey']) ?? '' },
  );

/** Newest period first: (period start, id) descending. */
const newestFirst = (left: ReviewSummary, right: ReviewSummary): number =>
  left.period.start !== right.period.start
    ? left.period.start < right.period.start
      ? 1
      : -1
    : left.reviewId < right.reviewId
      ? 1
      : left.reviewId > right.reviewId
        ? -1
        : 0;

export function createReviewTestQueries(
  unitOfWork: InMemoryUnitOfWork,
  profile: PlanProfile,
): ReviewTestQueries {
  const today = createTodayTestQueries(unitOfWork, profile);
  const planning = createTestPlanningQueries(unitOfWork, profile);
  const calls: ReviewQueryCall[] = [];
  const log = (method: keyof ReviewQueryPort, args: readonly unknown[]): void => {
    calls.push({ method, args });
  };
  const all = (type: EntityType, ownerId: OwnerId): CanonicalRecordState[] =>
    [...unitOfWork.state.records.values()].filter(
      (record) => record.ref.type === type && record.ref.ownerId === ownerId,
    );
  const find = (type: EntityType, ownerId: OwnerId, id: string): CanonicalRecordState | null =>
    unitOfWork.get(entityRefKey(createEntityRef(type, id as UUID, ownerId))) ?? null;

  const reviewPeriod = (document: ReviewDocument): ReviewPeriod => ({
    type: document.reviewType,
    key: document.periodKey,
    start: document.periodStart,
    end: document.periodEnd,
    ...(document.weekStart === undefined ? {} : { weekStart: document.weekStart }),
  });

  const activeItems = (ownerId: OwnerId, reviewId: UUID): CanonicalRecordState[] =>
    all('review_item', ownerId)
      .filter((record) => {
        const document = record.document as unknown as ReviewItemDocument;
        return document.reviewId === reviewId && document.archivedAt === undefined;
      })
      .sort(byOrder);

  /** The review's audit event times: first save and last change. */
  const timestamps = (record: CanonicalRecordState) => {
    const times = unitOfWork.state.events
      .filter(
        ({ event }) =>
          event.aggregate.type === 'review' &&
          event.aggregate.id === record.ref.id &&
          event.aggregate.ownerId === record.ref.ownerId,
      )
      .map(({ event }) => event.occurredAt);
    return { createdAt: times[0] ?? seededAt, updatedAt: times.at(-1) ?? seededAt };
  };

  const summary = (record: CanonicalRecordState): ReviewSummary | null => {
    const document = record.document as unknown as ReviewDocument;
    if (document.state === 'archived') return null;
    const { createdAt, updatedAt } = timestamps(record);
    return {
      reviewId: record.ref.id,
      localRevision: record.localRevision,
      period: reviewPeriod(document),
      state: document.state,
      ...(document.energy === undefined ? {} : { energy: document.energy }),
      ...(document.notes === undefined ? {} : { notesExcerpt: document.notes.slice(0, 200) }),
      decisionCount: activeItems(record.ref.ownerId, record.ref.id).length,
      updatedAt,
      createdAt,
      ...(document.completedAt === undefined ? {} : { completedAt: document.completedAt }),
    };
  };

  const titled = (
    kind: 'axis' | 'outcome' | 'milestone' | 'project' | 'action',
    ownerId: OwnerId,
    id: UUID,
  ): ReviewItemTargetView => {
    const record = find(kind, ownerId, id);
    if (record === null) return { kind: 'deleted' };
    return {
      kind,
      id,
      title: text(record.document['title']) ?? '',
      state: text(record.document['state']) ?? 'active',
    };
  };

  const targetView = (ownerId: OwnerId, document: ReviewItemDocument): ReviewItemTargetView => {
    const target = document.target;
    switch (target.kind) {
      case 'axis':
        return titled('axis', ownerId, target.axisId);
      case 'outcome':
        return titled('outcome', ownerId, target.outcomeId);
      case 'milestone':
        return titled('milestone', ownerId, target.milestoneId);
      case 'project':
        return titled('project', ownerId, target.projectId);
      case 'action':
        return titled('action', ownerId, target.actionId);
      case 'routine_occurrence': {
        const routine = find('routine', ownerId, target.routineId);
        if (routine === null) return { kind: 'deleted' };
        const occurrence = find(
          'routine_occurrence',
          ownerId,
          routineOccurrenceId(
            occurrenceLogicalKey(target.routineId, target.generation, target.period),
          ),
        );
        return {
          kind: 'routine_occurrence',
          routineId: target.routineId,
          routineTitle: (routine.document as RoutineDocument).title,
          occurrence: {
            routineId: target.routineId,
            generation: target.generation,
            period: target.period,
            ...(occurrence === null ? {} : { revision: occurrence.localRevision }),
          },
        };
      }
      case 'routine':
      case 'commitment': {
        const record = find(
          target.kind,
          ownerId,
          target.kind === 'routine' ? target.routineId : target.commitmentId,
        );
        return record === null
          ? { kind: 'deleted' }
          : { kind: target.kind, id: record.ref.id, title: text(record.document['title']) ?? '' };
      }
      case 'deleted':
        return { kind: 'deleted' };
    }
  };

  const axisTitle = (ownerId: OwnerId, axisId: UUID | undefined): string | undefined =>
    axisId === undefined ? undefined : text(find('axis', ownerId, axisId)?.document['title']);

  const objectRow = (
    kind: ReviewObjectRow['kind'],
    ownerId: OwnerId,
    record: CanonicalRecordState,
  ): ReviewObjectRow => {
    const document = record.document;
    const context =
      kind === 'milestone'
        ? text(
            find('outcome', ownerId, (document as MilestoneDocument).outcomeId)?.document['title'],
          )
        : axisTitle(ownerId, (document as OutcomeDocument | ProjectDocument).axisId);
    const targetStart = text(document['targetStart']) as CalendarDate | undefined;
    const targetEnd = text(document['targetEnd']) as CalendarDate | undefined;
    return {
      kind,
      id: record.ref.id,
      localRevision: record.localRevision,
      title: text(document['title']) ?? '',
      state: text(document['state']) ?? 'active',
      ...(context === undefined ? {} : { context }),
      ...(targetStart === undefined ? {} : { targetStart }),
      ...(targetEnd === undefined ? {} : { targetEnd }),
    };
  };

  /** Projects in Axis order (by the Axis order key), then unassigned, each in its own order. */
  const axisRank = (ownerId: OwnerId): ((record: CanonicalRecordState) => string) => {
    const axes = all('axis', ownerId).sort(byOrder);
    return (record) => {
      const axisId = (record.document as ProjectDocument).axisId;
      const index = axes.findIndex((axis) => axis.ref.id === axisId);
      return index < 0 ? '~' : String(index).padStart(6, '0');
    };
  };

  return {
    ...today,
    calls,
    listPlacements(ownerId, range) {
      log('listPlacements', [ownerId, range]);
      return planning.listPlacements(ownerId, range);
    },
    listBlocks(ownerId, startsAt, endsAt) {
      log('listBlocks', [ownerId, startsAt, endsAt]);
      return planning.listBlocks(ownerId, startsAt, endsAt);
    },
    listWeekSelections(ownerId, range) {
      log('listWeekSelections', [ownerId, range]);
      const rows: WeekSelectionRow[] = [];
      for (const record of all('focus_selection', ownerId)) {
        const document = record.document as FocusSelectionDocument;
        if (
          document.kind !== 'week_commitment' ||
          document.archivedAt !== undefined ||
          document.periodStart > range.end ||
          document.periodEnd < range.start
        )
          continue;
        const target = document.target;
        const targetId =
          target.kind === 'action'
            ? target.actionId
            : target.kind === 'project'
              ? target.projectId
              : target.kind === 'milestone'
                ? target.milestoneId
                : null;
        if (targetId === null || target.kind === 'routine_occurrence') continue;
        const targetRecord = find(target.kind, ownerId, targetId);
        // Commitments of archived targets are not listed (as the SQLite statement does).
        if (targetRecord === null || targetRecord.document['state'] === 'archived') continue;
        rows.push({
          id: record.ref.id,
          localRevision: record.localRevision,
          period: {
            kind: 'week',
            start: document.periodStart,
            end: document.periodEnd,
            weekStart: document.weekStart ?? 'monday',
          },
          orderKey: document.orderKey,
          target: {
            kind: target.kind,
            id: targetId,
            title: text(targetRecord.document['title']) ?? '',
            state: text(targetRecord.document['state']) ?? 'active',
          } as WeekSelectionRow['target'],
        });
      }
      return Promise.resolve(
        rows.sort(
          (left, right) =>
            byText(left.period.start, right.period.start) || compareOrder(left, right),
        ),
      );
    },
    listMonthThemes(ownerId, year) {
      log('listMonthThemes', [ownerId, year]);
      return Promise.resolve(
        all('theme', ownerId)
          .filter((record) => {
            const document = record.document as MonthThemeDocument;
            return document.archivedAt === undefined && document.month.startsWith(`${year}-`);
          })
          .map((record) => {
            const document = record.document as MonthThemeDocument;
            return {
              id: record.ref.id,
              localRevision: record.localRevision,
              month: document.month,
              text: document.text,
            };
          }),
      );
    },
    getYearDirection(ownerId, year) {
      log('getYearDirection', [ownerId, year]);
      const record = all('direction', ownerId).find((candidate) => {
        const document = candidate.document as YearDirectionDocument;
        return document.archivedAt === undefined && document.year === year;
      });
      if (record === undefined) return Promise.resolve(null);
      const document = record.document as YearDirectionDocument;
      return Promise.resolve({
        id: record.ref.id,
        localRevision: record.localRevision,
        year: document.year,
        text: document.text,
      });
    },
    getReviewRecord(ownerId, profileId, period) {
      log('getReviewRecord', [ownerId, profileId, period]);
      const record = all('review', ownerId).find((candidate) => {
        const document = candidate.document as unknown as ReviewDocument;
        return (
          document.profileId === profileId &&
          document.state !== 'archived' &&
          document.reviewType === period.type &&
          document.periodStart === period.start &&
          document.periodEnd === period.end
        );
      });
      return Promise.resolve(record ?? null);
    },
    listReviewItems(ownerId, reviewId) {
      log('listReviewItems', [ownerId, reviewId]);
      const rows: ReviewItemRow[] = activeItems(ownerId, reviewId)
        .slice(0, reviewLimits.items + 1)
        .map((record) => ({
          record,
          target: targetView(ownerId, record.document as unknown as ReviewItemDocument),
        }));
      return Promise.resolve(rows);
    },
    getReviewReminder(ownerId, reviewId) {
      log('getReviewReminder', [ownerId, reviewId]);
      // The scheduled reminder, else the last one created (the store keeps no update time).
      const reminders = all('reminder', ownerId).filter(
        (record) => record.document['reviewId'] === reviewId,
      );
      return Promise.resolve(
        reminders.find((record) => record.document['state'] === 'scheduled') ??
          reminders.at(-1) ??
          null,
      );
    },
    listReviews(ownerId, profileId, options) {
      log('listReviews', [ownerId, profileId, options]);
      const before = options.before;
      const rows = all('review', ownerId)
        .filter((record) => {
          const document = record.document as unknown as ReviewDocument;
          return (
            document.profileId === profileId &&
            (options.type === undefined || document.reviewType === options.type) &&
            document.state !== 'archived' &&
            options.states.includes(document.state)
          );
        })
        .flatMap((record) => {
          const row = summary(record);
          return row === null ? [] : [row];
        })
        .filter(
          (row) =>
            before === undefined ||
            row.period.start < before.periodStart ||
            (row.period.start === before.periodStart && row.reviewId < before.id),
        )
        .sort(newestFirst);
      return Promise.resolve(rows.slice(0, clampLimit(options.limit)));
    },
    countInboxActions(ownerId) {
      log('countInboxActions', [ownerId]);
      return Promise.resolve(
        all('action', ownerId).filter(
          (record) => (record.document as ActionCanonicalDocument).state === 'inbox',
        ).length,
      );
    },
    listReviewProjects(ownerId, limit) {
      log('listReviewProjects', [ownerId, limit]);
      const rank = axisRank(ownerId);
      const projects = all('project', ownerId)
        .filter((record) => ['active', 'blocked'].includes(String(record.document['state'])))
        .sort((left, right) => byText(rank(left), rank(right)) || byOrder(left, right));
      const actions = all('action', ownerId);
      const rows = projects.map((record): ReviewProjectRow => {
        const document = record.document as ProjectDocument;
        const next = projectNextAction(
          document.state,
          actions
            .filter(
              (action) => (action.document as ActionCanonicalDocument).projectId === record.ref.id,
            )
            .map((action) => {
              const actionDocument = action.document as ActionCanonicalDocument;
              return {
                id: action.ref.id,
                state: actionDocument.state,
                orderKey: actionDocument.orderKey,
                title: actionDocument.title,
              };
            }),
        );
        return {
          ...(objectRow('project', ownerId, record) as ReviewObjectRow & { kind: 'project' }),
          kind: 'project',
          ...(next.status === 'present'
            ? { nextAction: { id: next.action.id, title: next.action.title } }
            : {}),
        };
      });
      return Promise.resolve(bounded(rows, limit));
    },
    listReviewAxes(ownerId, limit) {
      log('listReviewAxes', [ownerId, limit]);
      const rows = all('axis', ownerId)
        .filter((record) => (record.document as AxisDocument).state === 'active')
        .sort(byOrder)
        .map((record): ReviewAxisRow => {
          const document = record.document as AxisDocument;
          return {
            id: record.ref.id,
            title: document.title,
            ...(document.color === undefined ? {} : { color: document.color }),
            ...(document.icon === undefined ? {} : { icon: document.icon }),
          };
        });
      return Promise.resolve(bounded(rows, limit));
    },
    listReviewObjects(ownerId, kind, states, limit) {
      log('listReviewObjects', [ownerId, kind, states, limit]);
      const rows = all(kind, ownerId)
        .filter(
          (record) =>
            !isArchived(record.document) && states.includes(String(record.document['state'])),
        )
        .sort(byOrder)
        .map((record) => objectRow(kind, ownerId, record));
      return Promise.resolve(bounded(rows, limit));
    },
  };
}

/* ───────────────────────── Fixture seeder ───────────────────────── */

export interface ReviewSeedOptions {
  readonly id?: UUID;
  readonly revision?: number;
}

/**
 * Seeds Axes, Outcomes, Milestones, Projects, themes, directions, Week commitments, and reviews
 * straight into the in-memory unit of work (fixtures only; no command, event, or undo).
 */
export interface ReviewSeeder {
  axis(overrides?: Partial<AxisDocument>, options?: ReviewSeedOptions): CanonicalRecordState;
  outcome(overrides?: Partial<OutcomeDocument>, options?: ReviewSeedOptions): CanonicalRecordState;
  milestone(
    outcomeId: UUID,
    overrides?: Partial<MilestoneDocument>,
    options?: ReviewSeedOptions,
  ): CanonicalRecordState;
  project(overrides?: Partial<ProjectDocument>, options?: ReviewSeedOptions): CanonicalRecordState;
  theme(month: string, text: string, options?: ReviewSeedOptions): CanonicalRecordState;
  direction(year: string, text: string, options?: ReviewSeedOptions): CanonicalRecordState;
  /** An active Week commitment of an Action, Project, or Milestone. */
  commitment(
    target: FocusSelectionDocument['target'],
    week: { readonly start: string; readonly end: string; readonly weekStart: string },
    orderKey: string,
    options?: ReviewSeedOptions,
  ): CanonicalRecordState;
  review(
    period: ReviewPeriod,
    state: ReviewDocument['state'],
    overrides?: Partial<ReviewDocument>,
    options?: ReviewSeedOptions,
  ): CanonicalRecordState;
}

export function createReviewSeeder(
  unitOfWork: InMemoryUnitOfWork,
  ownerId: OwnerId,
  profile: PlanProfile,
  idPrefix = 'f0000000-0000-4000-8000-',
): ReviewSeeder {
  let sequence = 0;
  const nextId = (): UUID => {
    sequence += 1;
    return `${idPrefix}${String(sequence).padStart(12, '0')}` as UUID;
  };
  const orderKey = (): string => String(sequence * 1_000_000_000).padStart(15, '0');
  const seed = (type: EntityType, document: Doc, options: ReviewSeedOptions = {}) => {
    const record: CanonicalRecordState = {
      ref: createEntityRef(type, options.id ?? nextId(), ownerId),
      localRevision: options.revision ?? 1,
      serverRevision: 0,
      baseSnapshotHash: null,
      document,
    };
    unitOfWork.seed(record);
    return record;
  };
  return {
    axis: (overrides = {}, options) =>
      seed(
        'axis',
        { title: 'Health', orderKey: orderKey(), state: 'active', ...overrides },
        options,
      ),
    outcome: (overrides = {}, options) =>
      seed(
        'outcome',
        {
          title: 'Run a calm half marathon',
          successDefinition: 'Finish feeling well',
          progress: { mode: 'none' },
          orderKey: orderKey(),
          state: 'active',
          ...overrides,
        } satisfies OutcomeDocument,
        options,
      ),
    milestone: (outcomeId, overrides = {}, options) =>
      seed(
        'milestone',
        {
          title: 'Run 10 km',
          measurableCheckpoint: 'One 10 km run',
          outcomeId,
          orderKey: orderKey(),
          state: 'active',
          ...overrides,
        } satisfies MilestoneDocument,
        options,
      ),
    project: (overrides = {}, options) =>
      seed(
        'project',
        {
          title: 'Training plan',
          desiredResult: 'A plan I follow',
          orderKey: orderKey(),
          state: 'active',
          ...overrides,
        } satisfies ProjectDocument,
        options,
      ),
    theme: (month, value, options) =>
      seed('theme', { profileId: profile.profileId, month, text: value }, options),
    direction: (year, value, options) =>
      seed('direction', { profileId: profile.profileId, year, text: value }, options),
    commitment: (target, week, key, options) =>
      seed(
        'focus_selection',
        {
          kind: 'week_commitment',
          profileId: profile.profileId,
          target,
          periodStart: week.start,
          periodEnd: week.end,
          weekStart: week.weekStart,
          orderKey: key,
        },
        options,
      ),
    review: (period, state, overrides = {}, options) =>
      seed(
        'review',
        {
          profileId: profile.profileId,
          reviewType: period.type,
          periodKey: period.key,
          periodStart: period.start,
          periodEnd: period.end,
          ...(period.weekStart === undefined ? {} : { weekStart: period.weekStart }),
          state,
          ...overrides,
        },
        options,
      ),
  };
}
