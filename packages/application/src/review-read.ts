/**
 * Review reads: the overview of checkpoints and drafts, history pages, one
 * review with what it looks back on and plans for, and Today's calm notice. Read only: nothing here
 * writes, ranks, grades, or preselects, and an overdue review never blocks anything.
 */
import {
  isAlignedReviewPeriod,
  isFocusableActionState,
  isReviewablePeriod,
  isReviewType,
  localDateOf,
  localRangeBounds,
  parseCalendarDate,
  parseReviewPeriodKey,
  parseUUID,
  reviewDecisionSlot,
  reviewDue,
  reviewPlanningPeriod,
  reviewTypes,
  sameReviewPeriod,
  type ActionState,
  type CalendarDate,
  type MonthKey,
  type OwnerId,
  type ReviewDecisionSlot,
  type ReviewPeriod,
  type ReviewType,
  type UUID,
  type WeekPeriod,
  type YearKey,
} from '@yelaxis/domain';

import type { Bounded } from './alignment-contracts';
import type { CanonicalRecordState } from './contracts';
import type { ActionSummary, WeekSelectionRow } from './planning-contracts';
import { weekCommitmentRows } from './planning-week-commitments';
import type {
  DailyReviewContext,
  MonthlyReviewContext,
  ReviewApplication,
  ReviewCheckpoint,
  ReviewCommitmentCandidate,
  ReviewHistoryPage,
  ReviewNotice,
  ReviewOverview,
  ReviewSummary,
  ReviewView,
  SavedReview,
  SavedReviewItem,
  WeeklyReviewContext,
  YearlyReviewContext,
} from './review-contracts';
import {
  checkpointOf,
  periodSummary,
  reviewDocumentOf,
  reviewItemDocumentOf,
  weekOf,
  type ReviewKit,
  type ReviewSession,
} from './review-kit';
import { loadDay, loadFocusChoices, summaryOf } from './today-day';
import { readEndDay } from './today-end-day';

/** Bounds of the lists a review shows. */
export const reviewReadLimits = Object.freeze({
  inProgress: 20,
  historyPage: 20,
  lookBack: 50,
  projects: 50,
  axes: 50,
  candidates: 100,
  objects: 100,
});

/** Drafts are counted page by page; each page is one indexed read. */
const draftPageSize = 100;
const maxDraftPages = 10;

const unfinishedActionStates: readonly ActionState[] = [
  'inbox',
  'planned',
  'scheduled',
  'in_progress',
];

const bounded = <T>(items: readonly T[], limit: number): Bounded<T> => ({
  items: items.slice(0, limit),
  total: items.length,
});

/* ───────────────────────── Overview, notice, history ───────────────────────── */

async function checkpoints(
  kit: ReviewKit,
  session: ReviewSession,
  types: readonly ReviewType[],
): Promise<readonly ReviewCheckpoint[]> {
  const output: ReviewCheckpoint[] = [];
  for (const type of types) output.push(await checkpointOf(kit, session, type));
  return output;
}

/** Every draft, newest period first, read in bounded pages. */
async function listDrafts(kit: ReviewKit, session: ReviewSession): Promise<ReviewSummary[]> {
  const { ownerId, profile } = session;
  const drafts: ReviewSummary[] = [];
  let before: { readonly periodStart: CalendarDate; readonly id: UUID } | undefined;
  for (let page = 0; page < maxDraftPages; page += 1) {
    const rows = await kit.queries.listReviews(ownerId, profile.profileId, {
      states: ['draft'],
      ...(before === undefined ? {} : { before }),
      limit: draftPageSize,
    });
    drafts.push(...rows);
    const last = rows.at(-1);
    if (rows.length < draftPageSize || last === undefined) break;
    before = { periodStart: last.period.start, id: last.reviewId };
  }
  return drafts;
}

async function getOverview(kit: ReviewKit): Promise<ReviewOverview> {
  const session = await kit.session();
  const offered = await checkpoints(kit, session, reviewTypes);
  // Drafts of other periods: an earlier period, or one from before a zone or first-weekday change.
  const others = (await listDrafts(kit, session)).filter(
    (draft) => !offered.some((checkpoint) => sameReviewPeriod(checkpoint.period, draft.period)),
  );
  return {
    profile: session.profile,
    today: session.today,
    checkpoints: offered,
    inProgress: bounded(others, reviewReadLimits.inProgress),
  };
}

async function getNotice(kit: ReviewKit): Promise<ReviewNotice> {
  const session = await kit.session();
  // The daily review already has Today's End of day section.
  const offered = await checkpoints(kit, session, ['weekly', 'monthly', 'yearly']);
  return {
    due: offered.filter(
      (checkpoint) =>
        checkpoint.due !== 'not_due' &&
        checkpoint.status !== 'completed' &&
        checkpoint.status !== 'skipped',
    ),
  };
}

const cursorPattern = /^r1\.(\d{4}-\d{2}-\d{2})\.([0-9a-f-]{36})$/u;

/** An opaque history cursor: pass it back unchanged to read the next page. */
const encodeCursor = (summary: ReviewSummary): string =>
  `r1.${summary.period.start}.${summary.reviewId}`;

function decodeCursor(
  value: unknown,
): { readonly periodStart: CalendarDate; readonly id: UUID } | null {
  if (typeof value !== 'string') return null;
  const match = cursorPattern.exec(value);
  const date = parseCalendarDate(match?.[1] ?? '');
  const id = parseUUID(match?.[2] ?? '');
  return date.ok && id.ok ? { periodStart: date.value, id: id.value } : null;
}

async function listHistory(kit: ReviewKit, options: unknown): Promise<ReviewHistoryPage> {
  const { ownerId, profile } = await kit.session();
  const raw =
    typeof options === 'object' && options !== null
      ? (options as Readonly<Record<string, unknown>>)
      : {};
  const type = raw['type'];
  const cursor = raw['cursor'] === undefined ? undefined : decodeCursor(raw['cursor']);
  // An invalid type or cursor reads the first page of all reviews.
  const valid = (type === undefined || isReviewType(type)) && cursor !== null;
  const rows = await kit.queries.listReviews(ownerId, profile.profileId, {
    ...(valid && isReviewType(type) ? { type } : {}),
    states: ['draft', 'skipped', 'completed'],
    ...(valid && cursor !== undefined && cursor !== null ? { before: cursor } : {}),
    limit: reviewReadLimits.historyPage + 1,
  });
  const items = rows.slice(0, reviewReadLimits.historyPage);
  const last = items.at(-1);
  return {
    items,
    ...(rows.length > reviewReadLimits.historyPage && last !== undefined
      ? { nextCursor: encodeCursor(last) }
      : {}),
  };
}

/* ───────────────────────── One review ───────────────────────── */

async function savedReview(
  kit: ReviewKit,
  session: ReviewSession,
  record: CanonicalRecordState,
  period: ReviewPeriod,
): Promise<SavedReview> {
  const { ownerId, profile } = session;
  const document = reviewDocumentOf(record);
  const rows = await kit.queries.listReviewItems(ownerId, record.ref.id);
  const summary = await periodSummary(kit, ownerId, profile.profileId, period);
  if (summary === null) throw new Error('The saved review is missing from its history.');
  const positions = new Map<ReviewDecisionSlot, number>();
  const items = rows.map((row): SavedReviewItem => {
    const item = reviewItemDocumentOf(row.record);
    const slot = reviewDecisionSlot(item.decision);
    const position = (positions.get(slot) ?? 0) + 1;
    positions.set(slot, position);
    return {
      itemId: row.record.ref.id,
      localRevision: row.record.localRevision,
      target: row.target,
      decision: item.decision,
      ...(item.period === undefined ? {} : { period: item.period }),
      ...(item.note === undefined ? {} : { note: item.note }),
      position,
    };
  });
  return {
    reviewId: record.ref.id,
    localRevision: record.localRevision,
    state: summary.state,
    ...(document.notes === undefined ? {} : { notes: document.notes }),
    ...(document.energy === undefined ? {} : { energy: document.energy }),
    ...(document.themeText === undefined ? {} : { themeText: document.themeText }),
    ...(document.directionChoice === undefined
      ? {}
      : {
          direction: {
            choice: document.directionChoice,
            ...(document.directionText === undefined ? {} : { text: document.directionText }),
          },
        }),
    ...(document.clearedLists === undefined ? {} : { clearedLists: document.clearedLists }),
    items,
    createdAt: summary.createdAt ?? summary.updatedAt,
    updatedAt: summary.updatedAt,
    ...(document.completedAt === undefined ? {} : { completedAt: document.completedAt }),
  };
}

async function getReview(
  kit: ReviewKit,
  type: unknown,
  periodKey: unknown,
): Promise<ReviewView | null> {
  const parsed = parseReviewPeriodKey(type, periodKey);
  if (!parsed.ok) return null;
  const period = parsed.value;
  const session = await kit.session();
  const { ownerId, profile, today } = session;
  const record = await kit.queries.getReviewRecord(ownerId, profile.profileId, period);
  const saved = record === null ? null : await savedReview(kit, session, record, period);
  const reviewable = isReviewablePeriod(period, today);
  const aligned = isAlignedReviewPeriod(period, profile.weekStart);
  const planning = reviewable ? reviewPlanningPeriod(period, today, profile.weekStart) : null;
  const current = await checkpointOf(kit, session, period.type);
  const editable = reviewable && saved?.state !== 'completed' && (aligned || saved !== null);
  const base = {
    profile,
    today,
    period,
    due: reviewDue(period, today),
    reviewable,
    aligned,
    currentCheckpoint: current.period,
    ...(planning?.ok === true ? { planning: planning.value } : {}),
    saved,
    editable,
  };
  // The context is read only when the review can still be saved, skipped, or finished.
  const plan = editable && planning?.ok === true ? planning.value : null;
  switch (period.type) {
    case 'daily':
      return {
        ...base,
        type: 'daily',
        context: plan === null ? null : await dailyContext(kit, period),
      };
    case 'weekly':
      return {
        ...base,
        type: 'weekly',
        context: plan === null ? null : await weeklyContext(kit, session, period, plan),
      };
    case 'monthly':
      return {
        ...base,
        type: 'monthly',
        context: plan === null ? null : await monthlyContext(kit, ownerId, plan),
      };
    case 'yearly':
      return {
        ...base,
        type: 'yearly',
        context: plan === null ? null : await yearlyContext(kit, ownerId, period, plan),
      };
  }
}

/* ───────────────────────── Contexts ───────────────────────── */

/** The daily review is the End Day page for the reviewed date. */
async function dailyContext(kit: ReviewKit, period: ReviewPeriod): Promise<DailyReviewContext> {
  return { endDay: await readEndDay(kit, period.key) };
}

/**
 * The reviewed week, plan-scoped like End Day: Actions placed on the Week or one of its days, or
 * with a block in it, in plan order (by day: blocks by start, then Day placements; then the Week's
 * own placements), each once.
 */
async function lookBack(
  kit: ReviewKit,
  session: ReviewSession,
  period: ReviewPeriod,
): Promise<Pick<WeeklyReviewContext, 'done' | 'open' | 'routines'>> {
  const { ownerId, profile } = session;
  const range = { start: period.start, end: period.end };
  const inWeek = (date: CalendarDate): boolean => period.start <= date && date <= period.end;
  const entries: { readonly sort: string; readonly action: ActionSummary | UUID }[] = [];
  for (const row of await kit.queries.listPlacements(ownerId, range)) {
    if (row.target.kind !== 'action') continue;
    const placed = row.period;
    if (placed.kind === 'day' && inWeek(placed.date))
      entries.push({
        sort: `${placed.date}|1|${row.orderKey}|${row.id}`,
        action: row.target.action,
      });
    else if (placed.kind === 'week' && placed.start === period.start && placed.end === period.end)
      entries.push({ sort: `~|2|${row.orderKey}|${row.id}`, action: row.target.action });
  }
  const bounds = localRangeBounds(range, profile.planningTimeZone);
  for (const block of await kit.queries.listBlocks(ownerId, bounds.startsAt, bounds.endsAt)) {
    if (block.target.kind !== 'action') continue;
    const date = localDateOf(block.startsAt, profile.planningTimeZone);
    entries.push({
      sort: `${date}|0|${block.startsAt}|${block.id}`,
      action: block.target.actionId,
    });
  }
  entries.sort((left, right) => (left.sort < right.sort ? -1 : left.sort > right.sort ? 1 : 0));

  const known = new Map<UUID, ActionSummary>();
  for (const entry of entries)
    if (typeof entry.action !== 'string') known.set(entry.action.id, entry.action);
  const seen = new Set<UUID>();
  const done: ActionSummary[] = [];
  const open: ActionSummary[] = [];
  for (const entry of entries) {
    const id = typeof entry.action === 'string' ? entry.action : entry.action.id;
    if (seen.has(id)) continue;
    seen.add(id);
    let action = known.get(id);
    if (action === undefined) {
      const row = await kit.queries.getFocusAction(ownerId, id);
      if (row === null) continue;
      action = summaryOf(row);
    }
    if (action.state === 'completed') done.push(action);
    else if (unfinishedActionStates.includes(action.state)) open.push(action);
  }

  let completed = 0;
  let skipped = 0;
  for (const occurrence of await kit.queries.listMaterializedOccurrences(ownerId, range)) {
    if (occurrence.period.kind !== 'date') continue;
    if (!inWeek(occurrence.override?.date ?? occurrence.period.date)) continue;
    if (occurrence.state === 'completed') completed += 1;
    else if (occurrence.state === 'skipped') skipped += 1;
  }
  return {
    done: bounded(done, reviewReadLimits.lookBack),
    open: bounded(open, reviewReadLimits.lookBack),
    routines: { completed, skipped },
  };
}

/**
 * What can become one of the planning Week's commitments, never ranked or preselected: unfinished
 * Actions placed on the Week (placement order) or its days (by day, placement order), then active
 * and blocked Projects, then active Milestones. Only current commitments are marked selected.
 */
async function commitmentCandidates(
  kit: ReviewKit,
  ownerId: OwnerId,
  week: WeekPeriod,
  commitments: readonly WeekSelectionRow[],
  projects: WeeklyReviewContext['projects'],
): Promise<Bounded<ReviewCommitmentCandidate>> {
  const selected = new Set(commitments.map((row) => `${row.target.kind}:${row.target.id}`));
  const candidate = (
    kind: ReviewCommitmentCandidate['kind'],
    id: UUID,
    title: string,
    state: string,
  ): ReviewCommitmentCandidate => ({
    kind,
    id,
    title,
    state,
    selected: selected.has(`${kind}:${id}`),
  });

  const placed: { readonly sort: string; readonly action: ActionSummary }[] = [];
  for (const row of await kit.queries.listPlacements(ownerId, {
    start: week.start,
    end: week.end,
  })) {
    if (row.target.kind !== 'action' || !isFocusableActionState(row.target.action.state)) continue;
    const period = row.period;
    const sort =
      period.kind === 'week' && period.start === week.start && period.end === week.end
        ? `0|${row.orderKey}|${row.id}`
        : period.kind === 'day' && week.start <= period.date && period.date <= week.end
          ? `1|${period.date}|${row.orderKey}|${row.id}`
          : null;
    if (sort !== null) placed.push({ sort, action: row.target.action });
  }
  placed.sort((left, right) => (left.sort < right.sort ? -1 : left.sort > right.sort ? 1 : 0));
  const actions: ReviewCommitmentCandidate[] = [];
  const seen = new Set<UUID>();
  for (const { action } of placed) {
    if (seen.has(action.id)) continue;
    seen.add(action.id);
    actions.push(candidate('action', action.id, action.title, action.state));
  }
  const milestones = await kit.queries.listReviewObjects(
    ownerId,
    'milestone',
    ['active'],
    reviewReadLimits.candidates,
  );
  const items = [
    ...actions,
    ...projects.items.map((row) => candidate('project', row.id, row.title, row.state)),
    ...milestones.items.map((row) => candidate('milestone', row.id, row.title, row.state)),
  ];
  return {
    items: items.slice(0, reviewReadLimits.candidates),
    total: actions.length + projects.total + milestones.total,
  };
}

async function weeklyContext(
  kit: ReviewKit,
  session: ReviewSession,
  period: ReviewPeriod,
  planning: ReviewPeriod,
): Promise<WeeklyReviewContext> {
  const { ownerId, today } = session;
  const look = await lookBack(kit, session, period);
  const inboxCount = await kit.queries.countInboxActions(ownerId);
  // One read serves the Projects list (50) and the commitment candidates (100).
  const projectRows = await kit.queries.listReviewProjects(ownerId, reviewReadLimits.candidates);
  const axes = await kit.queries.listReviewAxes(ownerId, reviewReadLimits.axes);
  const week = weekOf(planning);
  const commitments = await weekCommitmentRows(kit.queries, ownerId, week);
  const candidates = await commitmentCandidates(kit, ownerId, week, commitments, projectRows);
  const firstDay = week.start < today ? today : week.start;
  return {
    ...look,
    inboxCount,
    projects: {
      items: projectRows.items.slice(0, reviewReadLimits.projects),
      total: projectRows.total,
    },
    axes,
    planningWeek: week,
    commitments,
    commitmentCandidates: candidates,
    firstDayFocus: await loadFocusChoices(kit, session, await loadDay(kit, session, firstDay)),
  };
}

async function monthlyContext(
  kit: ReviewKit,
  ownerId: OwnerId,
  planning: ReviewPeriod,
): Promise<MonthlyReviewContext> {
  const month = planning.key as MonthKey;
  const outcomes = await kit.queries.listReviewObjects(
    ownerId,
    'outcome',
    ['active', 'paused'],
    reviewReadLimits.objects,
  );
  const milestones = await kit.queries.listReviewObjects(
    ownerId,
    'milestone',
    ['active'],
    reviewReadLimits.objects,
  );
  const projects = await kit.queries.listReviewObjects(
    ownerId,
    'project',
    ['active', 'blocked', 'paused'],
    reviewReadLimits.objects,
  );
  const themes = await kit.queries.listMonthThemes(ownerId, month.slice(0, 4) as YearKey);
  const theme = themes.find((row) => row.month === month)?.text;
  return {
    outcomes,
    milestones,
    projects,
    planningMonth: month,
    ...(theme === undefined ? {} : { theme }),
  };
}

async function yearlyContext(
  kit: ReviewKit,
  ownerId: OwnerId,
  period: ReviewPeriod,
  planning: ReviewPeriod,
): Promise<YearlyReviewContext> {
  const outcomes = await kit.queries.listReviewObjects(
    ownerId,
    'outcome',
    ['active', 'paused'],
    reviewReadLimits.objects,
  );
  const reviewed = await kit.queries.getYearDirection(ownerId, period.key as YearKey);
  const planningYear = planning.key as YearKey;
  const current = await kit.queries.getYearDirection(ownerId, planningYear);
  return {
    outcomes,
    ...(reviewed === null ? {} : { reviewedDirection: reviewed.text }),
    planningYear,
    ...(current === null ? {} : { planningDirection: current.text }),
  };
}

/* ───────────────────────── Methods ───────────────────────── */

export type ReviewReadMethods = Pick<
  ReviewApplication,
  'getOverview' | 'listHistory' | 'getReview' | 'getNotice'
>;

export function createReviewReads(kit: ReviewKit): ReviewReadMethods {
  return {
    getOverview: () => getOverview(kit),
    listHistory: (options) => listHistory(kit, options),
    getReview: (type, periodKey) => getReview(kit, type, periodKey),
    getNotice: () => getNotice(kit),
  };
}
