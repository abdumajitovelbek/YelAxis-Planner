import type {
  ActionSummary,
  BlockRow,
  Bounded,
  CanonicalRecordState,
  ConstraintRow,
  DateRangeInput,
  DayFocusRow,
  DirectionRow,
  FocusActionRow,
  PlacementRow,
  PlacementTargetDocument,
  PlanProfile,
  ReviewAxisRow,
  ReviewItemRow,
  ReviewItemTargetView,
  ReviewObjectRow,
  ReviewProjectRow,
  ReviewQueryPort,
  ReviewSummary,
  RoutineRow,
  ThemeRow,
  WeekSelectionRow,
} from '@yelaxis/application';
import {
  energyLabels,
  parseCalendarDate,
  parseUUID,
  reviewLimits,
  type CalendarDate,
  type GeneratedOccurrencePeriod,
  type Instant,
  type MaterializedOccurrenceSnapshot,
  type OwnerId,
  type ReviewPeriod,
  type ReviewType,
  type UUID,
  type YearKey,
} from '@yelaxis/domain';

import {
  reviewCanonicalCodec,
  reviewItemCanonicalCodec,
  type ReviewItemDocument,
} from '../application/review-codecs';
import type { SqliteDriver, SqliteParameter } from '../sqlite/driver';
import { nextActionIdSql } from './alignment-queries';
import { reminderCanonicalCodec } from '../application/planning-codecs';
import {
  integer,
  listLimit,
  oneOf,
  optionalText,
  spread,
  SqlitePlanningQueries,
  targetReminderSql,
  text,
  type Values,
} from './planning-queries';
import { reviewPeriodFromRow, reviewTypeValues } from './review-period-row';
import { SqliteTodayQueries } from './today-queries';

/*
 * review read model. Every statement is prepared, owner-scoped, bounded, and
 * searches a named index; parameters carry every value, and the only literals are fixed domain
 * vocabulary. Reads shared with Today and Plan delegate to their statements. Nothing here writes,
 * ranks, scores, or caches planning content outside SQLite.
 */

/** A review holds at most `reviewLimits.items` active items; one more row reveals an overflow. */
export const reviewItemRowLimit = reviewLimits.items + 1;

const listedReviewStates = ['draft', 'skipped', 'completed'] as const;
type ListedReviewState = (typeof listedReviewStates)[number];

/** Non-archived states each object kind can be listed in (the review may offer any subset). */
const reviewObjectStates = Object.freeze({
  outcome: ['active', 'paused', 'achieved', 'abandoned'],
  milestone: ['active', 'completed', 'canceled'],
  project: ['idea', 'active', 'blocked', 'paused', 'completed'],
} as const satisfies Record<ReviewObjectRow['kind'], readonly string[]>);

const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ');

interface ListStatement {
  /** Parameters: the filter parameters, then the limit. */
  readonly items: string;
  /** Parameters: the filter parameters. */
  readonly count: string;
}

/* ───────────────────────── Review items ───────────────────────── */

/** What each item names, joined by primary key; a missing or soft-deleted target reads as deleted. */
const itemTargetColumns = `
  tx.title AS axis_title, tx.state AS axis_state,
  tou.title AS outcome_title, tou.state AS outcome_state,
  tm.title AS milestone_title, tm.state AS milestone_state,
  tp.title AS project_title, tp.state AS project_state,
  ta.title AS action_title, ta.state AS action_state,
  tr.title AS routine_title, tc.title AS commitment_title`;

const itemTargetJoins = `
  LEFT JOIN axes tx ON tx.owner_id = i.owner_id AND tx.id = i.axis_id AND tx.deleted_at IS NULL
  LEFT JOIN outcomes tou ON tou.owner_id = i.owner_id AND tou.id = i.outcome_id
    AND tou.deleted_at IS NULL
  LEFT JOIN milestones tm ON tm.owner_id = i.owner_id AND tm.id = i.milestone_id
    AND tm.deleted_at IS NULL
  LEFT JOIN projects tp ON tp.owner_id = i.owner_id AND tp.id = i.project_id
    AND tp.deleted_at IS NULL
  LEFT JOIN actions ta ON ta.owner_id = i.owner_id AND ta.id = i.action_id
    AND ta.deleted_at IS NULL
  LEFT JOIN routines tr ON tr.owner_id = i.owner_id AND tr.id = i.routine_id
    AND tr.deleted_at IS NULL
  LEFT JOIN commitments tc ON tc.owner_id = i.owner_id AND tc.id = i.commitment_id
    AND tc.deleted_at IS NULL`;

/* ───────────────────────── Review summaries ───────────────────────── */

const reviewSummaryColumns = `
  r.id, r.local_revision, r.review_type, r.period_key, r.period_start_date, r.period_end_date,
  r.week_start, r.state, r.energy, substr(r.notes, 1, 200) AS notes_excerpt, r.created_at,
  r.updated_at, r.completed_at,
  (SELECT COUNT(*) FROM review_items i INDEXED BY idx_review_items_review
   WHERE i.owner_id = r.owner_id AND i.review_id = r.id AND i.archived_at IS NULL
     AND i.deleted_at IS NULL) AS decision_count`;

interface ReviewListStatement {
  /** Parameters: owner, profile, the filter parameters, limit. */
  readonly first: string;
  /** Parameters: owner, profile, the filter parameters, cursor start, cursor start, cursor id, limit. */
  readonly after: string;
}

/** Newest period first, ((period start, id) descending), with a strict keyset cursor. */
function reviewListStatement(index: string, filter: string): ReviewListStatement {
  const source = `SELECT ${reviewSummaryColumns} FROM review_checkpoints r INDEXED BY ${index}
    WHERE r.owner_id = ? AND r.profile_id = ? AND ${filter}`;
  const order = 'ORDER BY r.period_start_date DESC, r.id DESC LIMIT ?;';
  return Object.freeze({
    first: `${source} ${order}`,
    after: `${source}
      AND r.period_start_date <= ? AND (r.period_start_date < ? OR r.id < ?) ${order}`,
  });
}

/* ───────────────────────── Projects, Axes, and objects ───────────────────────── */

const reviewProjectWhere = `p.owner_id = ? AND p.state IN ('active', 'blocked')
  AND p.deleted_at IS NULL`;

/** Outcomes, Milestones, or Projects in some of their non-archived states, in their own order. */
function reviewObjectStatement(input: {
  readonly table: string;
  readonly index: string;
  readonly contextJoin: string;
  readonly stateCount: number;
}): ListStatement {
  const where = `n.owner_id = ? AND n.state IN (${placeholders(input.stateCount)})
    AND n.deleted_at IS NULL`;
  return Object.freeze({
    items: `SELECT n.id, n.title, n.state, n.local_revision, n.target_start_date,
        n.target_end_date, c.title AS context_title
      FROM ${input.table} n INDEXED BY ${input.index} ${input.contextJoin}
      WHERE ${where}
      ORDER BY n.sort_key, n.id
      LIMIT ?;`,
    count: `SELECT COUNT(*) AS count FROM ${input.table} n INDEXED BY ${input.index}
      WHERE ${where};`,
  });
}

/** Prepared statements. Exported so index use can be verified with EXPLAIN. */
export const reviewQuerySql = Object.freeze({
  /** The one non-archived review of a period. Parameters: owner, profile, type, start, end. */
  reviewRecord: `
    SELECT * FROM review_checkpoints INDEXED BY uq_active_review_period
    WHERE owner_id = ? AND profile_id = ? AND review_type = ? AND period_start_date = ?
      AND period_end_date = ? AND archived_at IS NULL AND deleted_at IS NULL
    LIMIT 1;`,
  /** A review's active items with what they name. Parameters: owner, review. */
  reviewItems: `
    SELECT i.*, ${itemTargetColumns}
    FROM review_items i INDEXED BY idx_review_items_review ${itemTargetJoins}
    WHERE i.owner_id = ? AND i.review_id = ? AND i.archived_at IS NULL AND i.deleted_at IS NULL
    ORDER BY i.sort_key ASC, i.id ASC
    LIMIT ${String(reviewItemRowLimit)};`,
  reviews: Object.freeze({
    /** One review type. Filter parameters: type, then three states (NULL pads unused ones). */
    type: reviewListStatement(
      'idx_review_history',
      `r.review_type = ? AND r.deleted_at IS NULL AND r.archived_at IS NULL
        AND r.state IN (?, ?, ?)`,
    ),
    /** Every review type. Filter parameters: three states (NULL pads unused ones). */
    all: reviewListStatement(
      'idx_review_history_all',
      `r.archived_at IS NULL AND r.deleted_at IS NULL AND r.state IN (?, ?, ?)`,
    ),
    /** Drafts of every review type. No filter parameters. */
    drafts: reviewListStatement(
      'idx_review_drafts',
      `r.state = 'draft' AND r.deleted_at IS NULL AND r.archived_at IS NULL`,
    ),
  }),
  /** A review's "Remind me to finish" reminder, scheduled first. Parameters: owner, review. */
  reviewReminder: targetReminderSql('review_id', 'idx_reminders_review'),
  /** Parameters: owner. */
  inboxCount: `
    SELECT COUNT(*) AS count FROM actions INDEXED BY idx_actions_inbox_order
    WHERE owner_id = ? AND state = 'inbox' AND archived_at IS NULL AND deleted_at IS NULL;`,
  /**
   * Active and blocked Projects in Axis order (active Axes, then archived ones, by order key),
   * then those in no Axis, each by order key; with the Axis title and the next action. The sort
   * covers only active and blocked Projects. Parameters: owner (then limit).
   */
  projects: Object.freeze({
    items: `
      SELECT p.id, p.title, p.state, p.local_revision, p.target_start_date, p.target_end_date,
             x.title AS context_title, na.id AS next_action_id, na.title AS next_action_title
      FROM projects p INDEXED BY idx_projects_order
      LEFT JOIN axes x ON x.owner_id = p.owner_id AND x.id = p.axis_id AND x.deleted_at IS NULL
      LEFT JOIN actions na ON na.owner_id = p.owner_id AND na.id = ${nextActionIdSql('p')}
      WHERE ${reviewProjectWhere}
      ORDER BY x.id IS NULL, x.state, x.sort_key, x.id, p.sort_key, p.id
      LIMIT ?;`,
    count: `SELECT COUNT(*) AS count FROM projects p INDEXED BY idx_projects_order
      WHERE ${reviewProjectWhere};`,
  } satisfies ListStatement),
  /** Active Axes by order key. Parameters: owner (then limit). */
  axes: Object.freeze({
    items: `
      SELECT x.id, x.title, x.color_token, x.icon_name
      FROM axes x INDEXED BY idx_axes_order
      WHERE x.owner_id = ? AND x.state = 'active' AND x.deleted_at IS NULL
      ORDER BY x.sort_key, x.id
      LIMIT ?;`,
    count: `SELECT COUNT(*) AS count FROM axes x INDEXED BY idx_axes_order
      WHERE x.owner_id = ? AND x.state = 'active' AND x.deleted_at IS NULL;`,
  } satisfies ListStatement),
  /**
   * Parameters: owner, one parameter per non-archived state of the kind (NULL pads unused ones),
   * (then limit). Context: the Axis title (Outcome, Project) or the parent Outcome title.
   */
  objects: Object.freeze({
    outcome: reviewObjectStatement({
      table: 'outcomes',
      index: 'idx_outcomes_order',
      contextJoin: `LEFT JOIN axes c ON c.owner_id = n.owner_id AND c.id = n.axis_id
        AND c.deleted_at IS NULL`,
      stateCount: reviewObjectStates.outcome.length,
    }),
    milestone: reviewObjectStatement({
      table: 'milestones',
      index: 'idx_milestones_order',
      contextJoin: `LEFT JOIN outcomes c ON c.owner_id = n.owner_id AND c.id = n.outcome_id
        AND c.deleted_at IS NULL`,
      stateCount: reviewObjectStates.milestone.length,
    }),
    project: reviewObjectStatement({
      table: 'projects',
      index: 'idx_projects_order',
      contextJoin: `LEFT JOIN axes c ON c.owner_id = n.owner_id AND c.id = n.axis_id
        AND c.deleted_at IS NULL`,
      stateCount: reviewObjectStates.project.length,
    }),
  }),
});

/* ───────────────────────── Parameters ───────────────────────── */

/** Distinct requested states, each checked against the allowed set; NULL pads to `size`. */
function stateParameters(
  states: readonly string[],
  allowed: readonly string[],
  size: number,
): SqliteParameter[] {
  const distinct = [...new Set(states)];
  if (distinct.some((state) => !allowed.includes(state))) {
    throw new RangeError('Choose valid states.');
  }
  return [...distinct, ...Array.from({ length: size - distinct.length }, () => null)];
}

function cursorParameters(before: {
  readonly periodStart: CalendarDate;
  readonly id: UUID;
}): SqliteParameter[] {
  const start = parseCalendarDate(before.periodStart);
  const id = parseUUID(before.id);
  if (!start.ok || !id.ok) throw new RangeError('Choose a valid review cursor.');
  // Ids are stored in lowercase; the parsed id is lowercase whatever case it was given in.
  return [start.value, start.value, id.value];
}

/* ───────────────────────── Row mappers ───────────────────────── */

function reviewSummary(row: Values): ReviewSummary {
  const period: ReviewPeriod = reviewPeriodFromRow(row);
  const energy = optionalText(row, 'energy');
  return {
    reviewId: text(row, 'id') as UUID,
    localRevision: integer(row, 'local_revision'),
    period,
    state: oneOf(row, 'state', listedReviewStates),
    ...spread('energy', energy === undefined ? undefined : oneOf(row, 'energy', energyLabels)),
    ...spread('notesExcerpt', optionalText(row, 'notes_excerpt')),
    decisionCount: integer(row, 'decision_count'),
    updatedAt: text(row, 'updated_at') as Instant,
    createdAt: text(row, 'created_at') as Instant,
    ...spread('completedAt', optionalText(row, 'completed_at') as Instant | undefined),
  };
}

type TitledKind = 'axis' | 'outcome' | 'milestone' | 'project' | 'action';

function titledView(row: Values, kind: TitledKind, id: string): ReviewItemTargetView {
  const title = optionalText(row, `${kind}_title`);
  return title === undefined
    ? { kind: 'deleted' }
    : { kind, id: id as UUID, title, state: text(row, `${kind}_state`) };
}

/** What a saved item names, from its decoded target and the joined target row. */
function itemTargetView(target: ReviewItemDocument['target'], row: Values): ReviewItemTargetView {
  switch (target.kind) {
    case 'deleted':
      return { kind: 'deleted' };
    case 'axis':
      return titledView(row, 'axis', target.axisId);
    case 'outcome':
      return titledView(row, 'outcome', target.outcomeId);
    case 'milestone':
      return titledView(row, 'milestone', target.milestoneId);
    case 'project':
      return titledView(row, 'project', target.projectId);
    case 'action':
      return titledView(row, 'action', target.actionId);
    case 'routine_occurrence': {
      const routineTitle = optionalText(row, 'routine_title');
      return routineTitle === undefined
        ? { kind: 'deleted' }
        : {
            kind: 'routine_occurrence',
            routineId: target.routineId as UUID,
            routineTitle,
            occurrence: {
              routineId: target.routineId,
              generation: target.generation,
              period: target.period as GeneratedOccurrencePeriod,
            },
          };
    }
    case 'routine': {
      const title = optionalText(row, 'routine_title');
      return title === undefined
        ? { kind: 'deleted' }
        : { kind: 'routine', id: target.routineId as UUID, title };
    }
    case 'commitment': {
      const title = optionalText(row, 'commitment_title');
      return title === undefined
        ? { kind: 'deleted' }
        : { kind: 'commitment', id: target.commitmentId as UUID, title };
    }
  }
}

function objectRow<Kind extends ReviewObjectRow['kind']>(
  kind: Kind,
  row: Values,
): ReviewObjectRow & { readonly kind: Kind } {
  return {
    kind,
    id: text(row, 'id') as UUID,
    localRevision: integer(row, 'local_revision'),
    title: text(row, 'title'),
    state: text(row, 'state'),
    ...spread('context', optionalText(row, 'context_title')),
    ...spread('targetStart', optionalText(row, 'target_start_date') as CalendarDate | undefined),
    ...spread('targetEnd', optionalText(row, 'target_end_date') as CalendarDate | undefined),
  };
}

function total(row: Values | undefined): number {
  return row === undefined ? 0 : integer(row, 'count');
}

/* ───────────────────────── Adapter ───────────────────────── */

/**
 * SQLite review read model. Today and Plan reads delegate to their own adapters; review
 * statements are bounded by a review, a page, or a requested limit (hard cap 200).
 */
export class SqliteReviewQueries implements ReviewQueryPort {
  readonly #today: SqliteTodayQueries;
  readonly #planning: SqlitePlanningQueries;

  constructor(private readonly driver: SqliteDriver) {
    this.#today = new SqliteTodayQueries(driver);
    this.#planning = new SqlitePlanningQueries(driver);
  }

  /* Today reads. */

  getPlanProfile(ownerId: OwnerId): Promise<PlanProfile> {
    return this.#today.getPlanProfile(ownerId);
  }

  readRecord(
    ownerId: OwnerId,
    ref: CanonicalRecordState['ref'],
  ): Promise<CanonicalRecordState | null> {
    return this.#today.readRecord(ownerId, ref);
  }

  listRoutines(
    ownerId: OwnerId,
    options: { readonly includeArchived: boolean },
  ): Promise<readonly RoutineRow[]> {
    return this.#today.listRoutines(ownerId, options);
  }

  listMaterializedOccurrences(
    ownerId: OwnerId,
    range: DateRangeInput,
    routineId?: UUID,
  ): Promise<readonly MaterializedOccurrenceSnapshot[]> {
    return this.#today.listMaterializedOccurrences(ownerId, range, routineId);
  }

  listCapacityConstraints(ownerId: OwnerId): Promise<readonly ConstraintRow[]> {
    return this.#today.listCapacityConstraints(ownerId);
  }

  getActivePlacement(
    ownerId: OwnerId,
    kind: PlacementTargetDocument['kind'],
    targetId: UUID,
  ): Promise<CanonicalRecordState | null> {
    return this.#today.getActivePlacement(ownerId, kind, targetId);
  }

  getPlannedActionBlock(ownerId: OwnerId, actionId: UUID): Promise<CanonicalRecordState | null> {
    return this.#today.getPlannedActionBlock(ownerId, actionId);
  }

  listDayBlocks(
    ownerId: OwnerId,
    bounds: { readonly startsAt: Instant; readonly endsAt: Instant },
  ): Promise<readonly BlockRow[]> {
    return this.#today.listDayBlocks(ownerId, bounds);
  }

  listDayActionPlacements(ownerId: OwnerId, date: CalendarDate): Promise<readonly PlacementRow[]> {
    return this.#today.listDayActionPlacements(ownerId, date);
  }

  listWeekActionPlacements(
    ownerId: OwnerId,
    date: CalendarDate,
    limit: number,
  ): Promise<Bounded<PlacementRow>> {
    return this.#today.listWeekActionPlacements(ownerId, date, limit);
  }

  listWeekCommitmentActions(
    ownerId: OwnerId,
    date: CalendarDate,
    limit: number,
  ): Promise<Bounded<ActionSummary>> {
    return this.#today.listWeekCommitmentActions(ownerId, date, limit);
  }

  listDayFocus(
    ownerId: OwnerId,
    profileId: UUID,
    date: CalendarDate,
  ): Promise<readonly DayFocusRow[]> {
    return this.#today.listDayFocus(ownerId, profileId, date);
  }

  getFocusAction(ownerId: OwnerId, actionId: UUID): Promise<FocusActionRow | null> {
    return this.#today.getFocusAction(ownerId, actionId);
  }

  /* Plan reads. */

  listPlacements(ownerId: OwnerId, range: DateRangeInput): Promise<readonly PlacementRow[]> {
    return this.#planning.listPlacements(ownerId, range);
  }

  listBlocks(ownerId: OwnerId, startsAt: Instant, endsAt: Instant): Promise<readonly BlockRow[]> {
    return this.#planning.listBlocks(ownerId, startsAt, endsAt);
  }

  listWeekSelections(
    ownerId: OwnerId,
    range: DateRangeInput,
  ): Promise<readonly WeekSelectionRow[]> {
    return this.#planning.listWeekSelections(ownerId, range);
  }

  listMonthThemes(ownerId: OwnerId, year: YearKey): Promise<readonly ThemeRow[]> {
    return this.#planning.listMonthThemes(ownerId, year);
  }

  getYearDirection(ownerId: OwnerId, year: YearKey): Promise<DirectionRow | null> {
    return this.#planning.getYearDirection(ownerId, year);
  }

  /* Review reads. */

  async getReviewRecord(
    ownerId: OwnerId,
    profileId: UUID,
    period: Pick<ReviewPeriod, 'type' | 'start' | 'end'>,
  ): Promise<CanonicalRecordState | null> {
    const row = await this.driver.get<Values>(reviewQuerySql.reviewRecord, [
      ownerId,
      profileId,
      period.type,
      period.start,
      period.end,
    ]);
    if (row === undefined) return null;
    return reviewCanonicalCodec.recordFromRow(
      { type: 'review', id: text(row, 'id') as UUID, ownerId },
      row,
    );
  }

  async listReviewItems(ownerId: OwnerId, reviewId: UUID): Promise<readonly ReviewItemRow[]> {
    const rows = await this.driver.all<Values>(reviewQuerySql.reviewItems, [ownerId, reviewId]);
    return rows.map((row) => {
      const record = reviewItemCanonicalCodec.recordFromRow(
        { type: 'review_item', id: text(row, 'id') as UUID, ownerId },
        row,
      );
      const document = record.document as unknown as ReviewItemDocument;
      return { record, target: itemTargetView(document.target, row) };
    });
  }

  async getReviewReminder(ownerId: OwnerId, reviewId: UUID): Promise<CanonicalRecordState | null> {
    const row = await this.driver.get<Values>(reviewQuerySql.reviewReminder, [ownerId, reviewId]);
    return row === undefined
      ? null
      : reminderCanonicalCodec.recordFromRow(
          { type: 'reminder', id: text(row, 'id') as UUID, ownerId },
          row,
        );
  }

  async listReviews(
    ownerId: OwnerId,
    profileId: UUID,
    options: {
      readonly type?: ReviewType;
      readonly states: readonly ListedReviewState[];
      readonly before?: { readonly periodStart: CalendarDate; readonly id: UUID };
      readonly limit: number;
    },
  ): Promise<readonly ReviewSummary[]> {
    const limit = listLimit(options.limit);
    const states = stateParameters(options.states, listedReviewStates, listedReviewStates.length);
    if (states.every((state) => state === null)) return [];
    if (options.type !== undefined && !reviewTypeValues.includes(options.type)) {
      throw new RangeError('Choose a daily, weekly, monthly, or yearly review.');
    }
    const draftsOnly = states[0] === 'draft' && states[1] === null;
    const [statement, filter]: [ReviewListStatement, SqliteParameter[]] =
      options.type !== undefined
        ? [reviewQuerySql.reviews.type, [options.type, ...states]]
        : draftsOnly
          ? [reviewQuerySql.reviews.drafts, []]
          : [reviewQuerySql.reviews.all, states];
    const rows =
      options.before === undefined
        ? await this.driver.all<Values>(statement.first, [ownerId, profileId, ...filter, limit])
        : await this.driver.all<Values>(statement.after, [
            ownerId,
            profileId,
            ...filter,
            ...cursorParameters(options.before),
            limit,
          ]);
    return rows.map(reviewSummary);
  }

  async countInboxActions(ownerId: OwnerId): Promise<number> {
    return total(await this.driver.get<Values>(reviewQuerySql.inboxCount, [ownerId]));
  }

  async listReviewProjects(ownerId: OwnerId, limit: number): Promise<Bounded<ReviewProjectRow>> {
    return this.#list(reviewQuerySql.projects, [ownerId], limit, (row) => {
      const nextId = optionalText(row, 'next_action_id');
      return {
        ...objectRow('project', row),
        ...(nextId === undefined
          ? {}
          : { nextAction: { id: nextId as UUID, title: text(row, 'next_action_title') } }),
      };
    });
  }

  async listReviewAxes(ownerId: OwnerId, limit: number): Promise<Bounded<ReviewAxisRow>> {
    return this.#list(reviewQuerySql.axes, [ownerId], limit, (row) => ({
      id: text(row, 'id') as UUID,
      title: text(row, 'title'),
      ...spread('color', optionalText(row, 'color_token')),
      ...spread('icon', optionalText(row, 'icon_name')),
    }));
  }

  async listReviewObjects(
    ownerId: OwnerId,
    kind: ReviewObjectRow['kind'],
    states: readonly string[],
    limit: number,
  ): Promise<Bounded<ReviewObjectRow>> {
    const allowed = reviewObjectStates[kind];
    const parameters = stateParameters(states, allowed, allowed.length);
    if (parameters.every((state) => state === null)) {
      listLimit(limit);
      return { items: [], total: 0 };
    }
    return this.#list(reviewQuerySql.objects[kind], [ownerId, ...parameters], limit, (row) =>
      objectRow(kind, row),
    );
  }

  async #list<Item>(
    statement: ListStatement,
    parameters: readonly SqliteParameter[],
    limit: number,
    map: (row: Values) => Item,
  ): Promise<Bounded<Item>> {
    // Sequential reads: the browser owns one SQLite worker connection.
    const rows = await this.driver.all<Values>(statement.items, [...parameters, listLimit(limit)]);
    const count = await this.driver.get<Values>(statement.count, parameters);
    return { items: rows.map(map), total: total(count) };
  }
}
