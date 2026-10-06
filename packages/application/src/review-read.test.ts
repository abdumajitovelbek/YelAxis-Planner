import {
  addDays,
  createWeekPeriod,
  entityRefKey,
  parseReviewPeriodKey,
  type CalendarDate,
  type IanaTimeZone,
  type Instant,
  type RecurrenceRuleV1,
  type ReviewPeriod,
  type ReviewType,
} from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import type { ReviewView } from './review-contracts';
import { accepted, createReviewFixture, type ReviewFixture } from './testing/review-fixtures';

const d = (value: string) => value as CalendarDate;
const today = d('2026-09-30');
const dailyRule: RecurrenceRuleV1 = {
  version: 1,
  kind: 'daily',
  intervalDays: 1,
  startsOn: d('2026-09-01'),
};
const onDay = (date: string) => ({ kind: 'day' as const, date: d(date) });

const period = (type: ReviewType, key: string): ReviewPeriod => {
  const parsed = parseReviewPeriodKey(type, key);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const keysOf = (checkpoints: readonly { readonly period: ReviewPeriod }[]) =>
  checkpoints.map((checkpoint) => `${checkpoint.period.type} ${checkpoint.period.key}`);

type ContextOf<T extends ReviewView['type']> = NonNullable<
  Extract<ReviewView, { readonly type: T }>['context']
>;

function contextOf<T extends ReviewView['type']>(view: ReviewView | null, type: T): ContextOf<T> {
  if (view === null || view.type !== type || view.context === null)
    throw new Error('Expected a context.');
  return view.context as unknown as ContextOf<T>;
}

/* ───────────────────────── Overview ───────────────────────── */

describe('getOverview', () => {
  it('offers one checkpoint per type, the previous period until it is settled', async () => {
    const f = createReviewFixture();
    const overview = await f.reviews.getOverview();
    expect(overview.today).toBe(today);
    expect(
      overview.checkpoints.map((checkpoint) => [
        `${checkpoint.period.type} ${checkpoint.period.key}`,
        checkpoint.due,
        checkpoint.status,
      ]),
    ).toEqual([
      ['daily 2026-09-30', 'due', 'not_started'],
      ['weekly 2026-09-21', 'ended', 'not_started'],
      // Today is September's last day.
      ['monthly 2026-09', 'due', 'not_started'],
      ['yearly 2025', 'ended', 'not_started'],
    ]);
    expect(overview.inProgress).toEqual({ items: [], total: 0 });

    f.seed.review(period('weekly', '2026-09-21'), 'completed');
    f.seed.review(period('yearly', '2025'), 'skipped');
    const settled = await f.reviews.getOverview();
    expect(
      settled.checkpoints.map((checkpoint) => [
        `${checkpoint.period.type} ${checkpoint.period.key}`,
        checkpoint.due,
        checkpoint.status,
      ]),
    ).toEqual([
      ['daily 2026-09-30', 'due', 'not_started'],
      ['weekly 2026-09-28', 'not_due', 'not_started'],
      ['monthly 2026-09', 'due', 'not_started'],
      ['yearly 2026', 'not_due', 'not_started'],
    ]);
  });

  it('offers the period itself on its last day, whatever happened before', async () => {
    // Sunday 2026-10-04, 09:00 in New York.
    const f = createReviewFixture('2026-10-04T13:00:00.000Z' as Instant);
    const overview = await f.reviews.getOverview();
    expect(keysOf(overview.checkpoints)).toEqual([
      'daily 2026-10-04',
      'weekly 2026-09-28',
      'monthly 2026-09',
      'yearly 2025',
    ]);
    expect(overview.checkpoints[1]?.due).toBe('due');
    // On a last day the previous period is not read: one history read per type, then the drafts.
    expect(
      f.queries.calls
        .filter(({ method }) => method === 'listReviews')
        .map(({ args }) => (args[2] as { type?: string }).type),
    ).toEqual(['daily', 'weekly', 'monthly', 'yearly', undefined]);
  });

  it('shows each checkpoint’s review and lists other drafts newest first', async () => {
    const f = createReviewFixture();
    accepted(
      await f.reviews.saveReview({
        type: 'monthly',
        periodKey: '2026-09',
        notes: 'x'.repeat(250),
        outcomes: [],
        milestones: [],
        projects: [],
      }),
    );
    f.seed.review(period('daily', '2026-09-20'), 'draft');
    f.seed.review(period('weekly', '2026-09-14'), 'draft');
    f.seed.review(period('daily', '2026-09-19'), 'completed');
    f.seed.review(period('daily', '2026-09-18'), 'archived', { stateBeforeArchive: 'draft' });
    const overview = await f.reviews.getOverview();
    const monthly = overview.checkpoints[2];
    expect(monthly?.status).toBe('draft');
    expect(monthly?.review).toMatchObject({
      state: 'draft',
      localRevision: 1,
      decisionCount: 0,
      notesExcerpt: 'x'.repeat(200),
      period: { type: 'monthly', key: '2026-09' },
    });
    expect(
      overview.inProgress.items.map((draft) => `${draft.period.type} ${draft.period.key}`),
    ).toEqual(['daily 2026-09-20', 'weekly 2026-09-14']);
    expect(overview.inProgress.total).toBe(2);
  });

  it('lists at most twenty other drafts with the full count', async () => {
    const f = createReviewFixture();
    for (let day = 0; day < 23; day += 1)
      f.seed.review(period('daily', addDays(d('2026-08-01'), day)), 'draft');
    const overview = await f.reviews.getOverview();
    expect(overview.inProgress.items).toHaveLength(20);
    expect(overview.inProgress.total).toBe(23);
    expect(overview.inProgress.items[0]?.period.key).toBe('2026-08-23');
  });
});

/* ───────────────────────── Notice ───────────────────────── */

describe('getNotice', () => {
  it('lists weekly, monthly, and yearly checkpoints on or after their last day that are open', async () => {
    const f = createReviewFixture();
    expect(keysOf((await f.reviews.getNotice()).due)).toEqual([
      'weekly 2026-09-21',
      'monthly 2026-09',
      'yearly 2025',
    ]);
    f.seed.review(period('weekly', '2026-09-21'), 'completed');
    f.seed.review(period('monthly', '2026-09'), 'skipped');
    f.seed.review(period('yearly', '2025'), 'draft');
    // A draft is still open; the settled week moves the weekly checkpoint to a week not yet due.
    expect(keysOf((await f.reviews.getNotice()).due)).toEqual(['yearly 2025']);
  });

  it('never offers a period that ended before the Profile existed', async () => {
    // Wednesday 2026-09-30 for a Profile created on Monday 2026-09-28.
    const f = createReviewFixture();
    const reviews = f.reviewsFor({ createdAt: '2026-09-28T12:00:00.000Z' as Instant });
    // September ends today, so it is offered; last week and 2025 ended before the Profile.
    expect(keysOf((await reviews.getNotice()).due)).toEqual(['monthly 2026-09']);
    const overview = await reviews.getOverview();
    expect(
      overview.checkpoints.map((checkpoint) => [
        `${checkpoint.period.type} ${checkpoint.period.key}`,
        checkpoint.due,
      ]),
    ).toEqual([
      ['daily 2026-09-30', 'due'],
      ['weekly 2026-09-28', 'not_due'],
      ['monthly 2026-09', 'due'],
      ['yearly 2026', 'not_due'],
    ]);
  });

  it('is quiet in the middle of periods once the previous ones are settled', async () => {
    // Thursday 2026-10-15.
    const f = createReviewFixture('2026-10-15T13:00:00.000Z' as Instant);
    f.seed.review(period('weekly', '2026-10-05'), 'completed');
    f.seed.review(period('monthly', '2026-09'), 'completed');
    f.seed.review(period('yearly', '2025'), 'skipped');
    expect((await f.reviews.getNotice()).due).toEqual([]);
  });
});

/* ───────────────────────── History ───────────────────────── */

describe('listHistory', () => {
  function historySetup(): ReviewFixture {
    const f = createReviewFixture();
    for (let day = 0; day < 22; day += 1)
      f.seed.review(
        period('daily', addDays(d('2026-09-01'), day)),
        day % 3 === 0 ? 'skipped' : day % 3 === 1 ? 'completed' : 'draft',
      );
    f.seed.review(period('weekly', '2026-09-07'), 'completed');
    f.seed.review(period('weekly', '2026-08-31'), 'archived', { stateBeforeArchive: 'draft' });
    return f;
  }

  it('pages through draft, skipped, and completed reviews, newest period first', async () => {
    const f = historySetup();
    const first = await f.reviews.listHistory();
    expect(first.items).toHaveLength(20);
    expect(first.items[0]?.period.key).toBe('2026-09-22');
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await f.reviews.listHistory({
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    });
    const keys = [...first.items, ...second.items].map(
      (item) => `${item.period.type} ${item.period.key}`,
    );
    expect(second.nextCursor).toBeUndefined();
    expect(keys).toHaveLength(23);
    expect(new Set(keys).size).toBe(23);
    expect(keys.slice(-3)).toEqual(['daily 2026-09-03', 'daily 2026-09-02', 'daily 2026-09-01']);
    // Reviews that start on the same day are ordered by id, newest id first.
    expect(keys.indexOf('weekly 2026-09-07')).toBe(keys.indexOf('daily 2026-09-07') - 1);
    // Archived reviews are never listed.
    expect(keys).not.toContain('weekly 2026-08-31');
  });

  it('filters by type, and reads the first page of all for an invalid type or cursor', async () => {
    const f = historySetup();
    expect(
      (await f.reviews.listHistory({ type: 'weekly' })).items.map((item) => item.period.key),
    ).toEqual(['2026-09-07']);
    const all = await f.reviews.listHistory();
    expect(await f.reviews.listHistory({ type: 'hourly' as ReviewType })).toEqual(all);
    expect(await f.reviews.listHistory({ cursor: 'not-a-cursor' })).toEqual(all);
    expect(await f.reviews.listHistory({ type: 'weekly', cursor: 'r1.2026-99-01.x' })).toEqual(all);
  });
});

/* ───────────────────────── One review ───────────────────────── */

describe('getReview', () => {
  it.each([
    ['quarterly', '2026'],
    ['daily', '2026-02-30'],
    ['weekly', 'last week'],
    ['monthly', '2026-13'],
    ['yearly', '26'],
  ])('is null for %s %s', async (type, key) => {
    const f = createReviewFixture();
    expect(await f.reviews.getReview(type, key)).toBeNull();
  });

  it('shows today’s daily review as End Day, with the carry date as its plan', async () => {
    const f = createReviewFixture();
    const open = f.plan.action({ title: 'Open work' });
    f.plan.placement(open.ref.id, onDay(today));
    const view = await f.reviews.getReview('daily', today);
    expect(view).toMatchObject({
      type: 'daily',
      today,
      period: { type: 'daily', key: today },
      due: 'due',
      reviewable: true,
      aligned: true,
      currentCheckpoint: { type: 'daily', key: today },
      planning: { type: 'daily', key: '2026-10-01' },
      saved: null,
      editable: true,
    });
    const context = contextOf(view, 'daily');
    expect(context.endDay).toMatchObject({ date: today, carryTo: '2026-10-01', available: true });
    expect(
      context.endDay.open.items.map((item) => (item.kind === 'action' ? item.action.title : '')),
    ).toEqual(['Open work']);
  });

  it('reads nothing more for a period that has not started or a finished review', async () => {
    const f = createReviewFixture();
    const future = await f.reviews.getReview('monthly', '2026-10');
    expect(future).toMatchObject({
      reviewable: false,
      editable: false,
      context: null,
      due: 'not_due',
    });
    expect(future).not.toHaveProperty('planning');

    f.seed.review(period('monthly', '2026-09'), 'completed', {
      notes: 'Done',
      completedAt: '2026-09-30T12:00:00.000Z' as Instant,
    });
    f.queries.calls.length = 0;
    const finished = await f.reviews.getReview('monthly', '2026-09');
    expect(finished).toMatchObject({ editable: false, context: null });
    expect(finished?.saved).toMatchObject({
      state: 'completed',
      notes: 'Done',
      completedAt: '2026-09-30T12:00:00.000Z',
    });
    expect(f.queries.calls.map(({ method }) => method)).not.toContain('listReviewObjects');
  });

  it('shows a saved review with its items, positions, and times', async () => {
    const f = createReviewFixture();
    const kept = f.seed.outcome({ title: 'Kept outcome' });
    const gone = f.seed.outcome({ title: 'Gone outcome' });
    const project = f.seed.project({ title: 'Training plan' });
    accepted(
      await f.reviews.saveReview({
        type: 'monthly',
        periodKey: '2026-09',
        notes: 'A steady month',
        outcomes: [
          { id: kept.ref.id, revision: 1, decision: 'continue' },
          { id: gone.ref.id, revision: 1, decision: 'archive' },
        ],
        milestones: [],
        projects: [{ id: project.ref.id, revision: 1, decision: 'pause' }],
        theme: 'Rest',
      }),
    );
    // The Outcome is permanently deleted later: its decision stays as "Deleted object".
    f.harness.unitOfWork.state.records.delete(entityRefKey(gone.ref));
    const view = await f.reviews.getReview('monthly', '2026-09');
    expect(view?.saved).toMatchObject({
      localRevision: 1,
      state: 'draft',
      notes: 'A steady month',
      themeText: 'Rest',
      createdAt: f.harness.dependencies.clock.now(),
      updatedAt: f.harness.dependencies.clock.now(),
    });
    expect(
      view?.saved?.items.map((item) => [
        item.target.kind === 'deleted' ? 'deleted' : item.target.kind,
        item.decision,
        item.position,
      ]),
    ).toEqual([
      ['outcome', 'continue', 1],
      ['deleted', 'archive', 2],
      ['project', 'pause', 3],
    ]);
    expect(view?.saved?.items[0]?.target).toMatchObject({ title: 'Kept outcome', state: 'active' });
  });

  it('keeps an unsaved week that no longer matches the first weekday out of reach', async () => {
    const f = createReviewFixture();
    const view = await f.reviews.getReview('weekly', '2026-09-22');
    expect(view).toMatchObject({
      aligned: false,
      reviewable: true,
      editable: false,
      context: null,
      currentCheckpoint: { type: 'weekly', key: '2026-09-21' },
    });
  });

  it('keeps a saved draft editable after a first-weekday change and points to the current checkpoint', async () => {
    const f = createReviewFixture();
    accepted(
      await f.reviews.saveReview({
        type: 'weekly',
        periodKey: '2026-09-21',
        projects: [],
        axisNotes: [],
        notes: 'Draft',
      }),
    );
    const view = await f.reviewsFor({ weekStart: 'sunday' }).getReview('weekly', '2026-09-21');
    expect(view).toMatchObject({
      aligned: false,
      editable: true,
      period: { key: '2026-09-21', start: '2026-09-21', end: '2026-09-27', weekStart: 'monday' },
      currentCheckpoint: { key: '2026-09-20', weekStart: 'sunday' },
      planning: { key: '2026-09-27', weekStart: 'sunday' },
    });
    expect(contextOf(view, 'weekly').planningWeek).toEqual(
      createWeekPeriod(d('2026-09-30'), 'sunday'),
    );
  });

  it('keeps a draft’s period after a planning-zone change and offers the new current period', async () => {
    // 16:00 on Wednesday 2026-09-30 in New York is already Thursday morning in Tokyo.
    const f = createReviewFixture('2026-09-30T20:00:00.000Z' as Instant);
    accepted(
      await f.reviews.saveReview({
        type: 'daily',
        periodKey: today,
        notes: 'Saved in New York',
        endDay: { actions: [], occurrences: [] },
      }),
    );
    const tokyo = f.reviewsFor({ planningTimeZone: 'Asia/Tokyo' as IanaTimeZone });
    const view = await tokyo.getReview('daily', today);
    expect(view).toMatchObject({
      today: '2026-10-01',
      period: { key: today },
      due: 'ended',
      editable: true,
      currentCheckpoint: { type: 'daily', key: '2026-10-01' },
      planning: { key: '2026-10-01' },
      saved: { notes: 'Saved in New York', state: 'draft' },
    });
    const overview = await tokyo.getOverview();
    expect(keysOf(overview.checkpoints)[0]).toBe('daily 2026-10-01');
    expect(overview.inProgress.items.map((draft) => draft.period.key)).toEqual([today]);
  });
});

/* ───────────────────────── Contexts ───────────────────────── */

describe('review contexts', () => {
  it('looks back on the week plan-scoped and plans the next week’s commitments and focus', async () => {
    const f = createReviewFixture();
    const walk = f.plan.routine(dailyRule);
    const done = f.plan.action({ title: 'Done', state: 'completed' });
    f.plan.placement(done.ref.id, onDay('2026-09-22'));
    const open = f.plan.action({ title: 'Open' });
    f.plan.placement(open.ref.id, onDay('2026-09-23'));
    const timed = f.plan.action({ title: 'Timed', state: 'scheduled' });
    f.plan.placement(timed.ref.id, onDay('2026-09-24'));
    f.plan.block(
      { kind: 'action', actionId: timed.ref.id },
      '2026-09-22T14:00:00.000Z',
      '2026-09-22T15:00:00.000Z',
    );
    const weekPlaced = f.plan.action({ title: 'Week placed' });
    f.plan.placement(weekPlaced.ref.id, createWeekPeriod(d('2026-09-21'), 'monday'));
    const canceled = f.plan.action({ title: 'Canceled', state: 'canceled' });
    f.plan.placement(canceled.ref.id, onDay('2026-09-25'));
    f.plan.placement(f.plan.action({ title: 'Next week' }).ref.id, onDay('2026-09-28'));
    f.plan.occurrence(walk.ref.id, { kind: 'date', date: d('2026-09-22') }, { state: 'completed' });
    f.plan.occurrence(walk.ref.id, { kind: 'date', date: d('2026-09-23') }, { state: 'skipped' });
    f.plan.occurrence(walk.ref.id, { kind: 'date', date: d('2026-09-24') }, { state: 'completed' });
    f.plan.occurrence(walk.ref.id, { kind: 'date', date: d('2026-09-28') }, { state: 'completed' });
    f.plan.action({ title: 'Captured', state: 'inbox' });
    f.plan.action({ title: 'Captured too', state: 'inbox' });
    const health = f.seed.axis({ title: 'Health' });
    f.seed.axis({ title: 'Old', state: 'archived' });
    const running = f.seed.project({ title: 'Running', axisId: health.ref.id });
    const next = f.plan.action({ title: 'Buy shoes', projectId: running.ref.id, state: 'planned' });
    f.seed.project({ title: 'Stuck', state: 'blocked' });
    f.seed.project({ title: 'Resting', state: 'paused' });
    const milestone = f.seed.milestone(f.seed.outcome().ref.id, { title: 'First 10 km' });
    const committed = f.seed.commitment(
      { kind: 'project', projectId: running.ref.id },
      { start: '2026-09-28', end: '2026-10-04', weekStart: 'monday' },
      '000000000000001',
    );
    const thisWeek = f.plan.action({ title: 'This week' });
    f.plan.placement(thisWeek.ref.id, onDay('2026-10-01'));

    const context = contextOf(await f.reviews.getReview('weekly', '2026-09-21'), 'weekly');
    expect(context.done).toEqual({ items: [expect.objectContaining({ title: 'Done' })], total: 1 });
    expect(context.open.items.map((action) => action.title)).toEqual([
      'Timed',
      'Open',
      'Week placed',
    ]);
    expect(context.routines).toEqual({ completed: 2, skipped: 1 });
    expect(context.inboxCount).toBe(2);
    expect(
      context.projects.items.map((project) => [project.title, project.nextAction?.id]),
    ).toEqual([
      ['Running', next.ref.id],
      ['Stuck', undefined],
    ]);
    expect(context.axes.items.map((axis) => axis.title)).toEqual(['Health']);
    expect(context.planningWeek).toEqual(createWeekPeriod(d('2026-09-28'), 'monday'));
    expect(context.commitments.map((row) => row.id)).toEqual([committed.ref.id]);
    expect(
      context.commitmentCandidates.items.map((candidate) => [
        candidate.kind,
        candidate.title,
        candidate.selected,
      ]),
    ).toEqual([
      ['action', 'Next week', false],
      ['action', 'This week', false],
      ['project', 'Running', true],
      ['project', 'Stuck', false],
      ['milestone', 'First 10 km', false],
    ]);
    expect(context.commitmentCandidates.total).toBe(5);
    expect(milestone.ref.id).toEqual(context.commitmentCandidates.items[4]?.id);
    // The planning Week began on Monday, so its first day's focus is chosen for today.
    expect(context.firstDayFocus).toMatchObject({ date: today, editable: true });
  });

  it('lists the monthly and yearly decisions with the planning month’s theme and the directions', async () => {
    const f = createReviewFixture();
    const active = f.seed.outcome({ title: 'Active' });
    f.seed.outcome({ title: 'Paused', state: 'paused' });
    f.seed.outcome({ title: 'Achieved', state: 'achieved' });
    f.seed.milestone(active.ref.id, { title: 'Open milestone' });
    f.seed.milestone(active.ref.id, { title: 'Done milestone', state: 'completed' });
    for (const state of ['idea', 'active', 'blocked', 'paused', 'completed'] as const)
      f.seed.project({ title: `Project ${state}`, state });
    f.seed.theme('2026-10', 'Rest well');
    f.seed.direction('2025', 'Build foundations');
    f.seed.direction('2026', 'Go deeper');

    const monthly = contextOf(await f.reviews.getReview('monthly', '2026-09'), 'monthly');
    expect(monthly.outcomes.items.map((row) => row.title)).toEqual(['Active', 'Paused']);
    expect(monthly.milestones.items.map((row) => [row.title, row.context])).toEqual([
      ['Open milestone', 'Active'],
    ]);
    expect(monthly.projects.items.map((row) => row.state)).toEqual(['active', 'blocked', 'paused']);
    expect(monthly).toMatchObject({ planningMonth: '2026-10', theme: 'Rest well' });

    const yearly = contextOf(await f.reviews.getReview('yearly', '2025'), 'yearly');
    expect(yearly).toMatchObject({
      reviewedDirection: 'Build foundations',
      planningYear: '2026',
      planningDirection: 'Go deeper',
    });
    expect(yearly.outcomes.total).toBe(2);
  });
});
