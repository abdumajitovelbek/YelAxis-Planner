import {
  entityRefKey,
  spacedOrderKey,
  type CalendarDate,
  type RecurrenceRuleV1,
  type ReviewDecisionKind,
  type UUID,
} from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import type { CanonicalRecordState } from './contracts';
import type {
  DailyReviewInput,
  MonthlyReviewInput,
  ReviewInput,
  ReviewObjectDecisionInput,
  WeeklyReviewInput,
  YearlyReviewInput,
} from './review-contracts';
import type { EndDayActionDecision } from './today-contracts';
import {
  accepted,
  commandId,
  createReviewFixture,
  refusalMessage,
  reviewProfile,
  type ReviewFixture,
} from './testing/review-fixtures';

const d = (value: string) => value as CalendarDate;
const today = d('2026-09-30');
const lastWeek = d('2026-09-21');
const dailyRule: RecurrenceRuleV1 = {
  version: 1,
  kind: 'daily',
  intervalDays: 1,
  startsOn: d('2026-09-01'),
};
const onDay = (date: string = today) => ({ kind: 'day' as const, date: d(date) });
const unknownId = 'a0000000-0000-4000-8000-00000000dead' as UUID;

const decide = (record: CanonicalRecordState, decision: EndDayActionDecision) => ({
  actionId: record.ref.id,
  revision: record.localRevision,
  decision,
});

const occurrence = (routine: CanonicalRecordState, date: string = today) => ({
  routineId: routine.ref.id,
  generation: 1,
  period: { kind: 'date' as const, date: d(date) },
});

/** A daily review of today; its End Day carries to tomorrow (Save ignores the carry date). */
const daily = (
  endDay: Partial<DailyReviewInput['endDay']> = {},
  overrides: Partial<DailyReviewInput> = {},
): DailyReviewInput => ({
  type: 'daily',
  periodKey: today,
  endDay: { actions: [], occurrences: [], carryTo: '2026-10-01', ...endDay },
  ...overrides,
});

const weekly = (overrides: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput => ({
  type: 'weekly',
  periodKey: lastWeek,
  projects: [],
  axisNotes: [],
  ...overrides,
});

const monthly = (overrides: Partial<MonthlyReviewInput> = {}): MonthlyReviewInput => ({
  type: 'monthly',
  periodKey: '2026-09',
  outcomes: [],
  milestones: [],
  projects: [],
  ...overrides,
});

const yearly = (overrides: Partial<YearlyReviewInput> = {}): YearlyReviewInput => ({
  type: 'yearly',
  periodKey: '2025',
  outcomes: [],
  ...overrides,
});

/** Stored review items in the person's order. */
const itemsOf = (f: ReviewFixture) =>
  f
    .records('review_item')
    .map((record) => record.document)
    .sort((left, right) => String(left['orderKey']).localeCompare(String(right['orderKey'])));

const activeItems = (f: ReviewFixture) =>
  itemsOf(f).filter((document) => document['archivedAt'] === undefined);

/** The one review record (tests use one period at a time). */
const theReview = (f: ReviewFixture): CanonicalRecordState => {
  const [review] = f.records('review');
  if (review === undefined) throw new Error('No review.');
  return review;
};

/* ───────────────────────── Save ───────────────────────── */

describe('saveReview', () => {
  it('saves a daily draft with its End Day choices and changes nothing in the plan', async () => {
    const f = createReviewFixture();
    const carried = f.plan.action({ title: 'Private carried title' });
    const carriedPlacement = f.plan.placement(carried.ref.id, onDay());
    const moved = f.plan.action();
    const movedPlacement = f.plan.placement(moved.ref.id, onDay());
    const walk = f.plan.routine(dailyRule, { title: 'Private walk' });

    const receipt = accepted(
      await f.reviews.saveReview(
        daily(
          {
            actions: [
              decide(carried, { kind: 'carry' }),
              decide(moved, { kind: 'move', period: { kind: 'week', date: '2026-10-07' } }),
            ],
            occurrences: [{ occurrence: occurrence(walk), decision: { kind: 'complete' } }],
            nextFocus: [{ kind: 'action', actionId: carried.ref.id }],
            // Save ignores the carry date.
            carryTo: '2020-01-01',
          },
          { notes: 'A private note', energy: 'medium' },
        ),
      ),
    );

    const review = theReview(f);
    expect(review.document).toEqual({
      profileId: reviewProfile.profileId,
      reviewType: 'daily',
      periodKey: today,
      periodStart: today,
      periodEnd: today,
      notes: 'A private note',
      energy: 'medium',
      state: 'draft',
    });
    const reviewId = review.ref.id;
    expect(itemsOf(f)).toEqual([
      {
        reviewId,
        target: { kind: 'action', actionId: carried.ref.id },
        decision: 'carry',
        orderKey: spacedOrderKey(0),
      },
      {
        reviewId,
        target: { kind: 'action', actionId: moved.ref.id },
        decision: 'move',
        // A move keeps its period, named by its first day.
        period: { kind: 'week', date: '2026-10-05' },
        orderKey: spacedOrderKey(1),
      },
      {
        reviewId,
        target: {
          kind: 'routine_occurrence',
          routineId: walk.ref.id,
          generation: 1,
          period: { kind: 'date', date: today },
        },
        decision: 'complete',
        orderKey: spacedOrderKey(2),
      },
      {
        reviewId,
        target: { kind: 'action', actionId: carried.ref.id },
        decision: 'focus',
        orderKey: spacedOrderKey(3),
      },
    ]);

    // A draft changes nothing in the plan: no placement moves, no occurrence, no focus.
    expect(f.document(carriedPlacement)).toEqual(carriedPlacement.document);
    expect(f.document(movedPlacement)).toEqual(movedPlacement.document);
    expect(f.document(carried)).toEqual(carried.document);
    expect(f.records('routine_occurrence')).toEqual([]);
    expect(f.records('focus_selection')).toEqual([]);

    expect(f.events()).toEqual([
      ['review.saved', { operation: 'create' }],
      ['review_item.saved', { operation: 'create' }],
      ['review_item.saved', { operation: 'create' }],
      ['review_item.saved', { operation: 'create' }],
      ['review_item.saved', { operation: 'create' }],
    ]);
    expect(JSON.stringify(f.harness.unitOfWork.state.events)).not.toContain('private');
    expect(receipt.undo.available).toBe(true);
    expect(f.harness.unitOfWork.state.undo[0]?.descriptor.commandType).toBe('planning.restore_v1');
  });

  it('resumes a draft: changed choices update, removed ones are archived, new ones are added', async () => {
    const f = createReviewFixture();
    const carried = f.plan.action();
    f.plan.placement(carried.ref.id, onDay());
    const moved = f.plan.action();
    f.plan.placement(moved.ref.id, onDay());
    const kept = f.plan.action();
    f.plan.placement(kept.ref.id, onDay());
    const walk = f.plan.routine(dailyRule);
    accepted(
      await f.reviews.saveReview(
        daily(
          {
            actions: [decide(carried, { kind: 'carry' }), decide(moved, { kind: 'carry' })],
            occurrences: [{ occurrence: occurrence(walk), decision: { kind: 'complete' } }],
            nextFocus: [{ kind: 'action', actionId: carried.ref.id }],
          },
          { notes: 'First thoughts', energy: 'low' },
        ),
      ),
    );
    const review = theReview(f);
    const first = f.records('review_item');
    f.harness.unitOfWork.state.events.length = 0;

    accepted(
      await f.reviews.saveReview(
        daily(
          {
            actions: [decide(carried, { kind: 'complete' }), decide(kept, { kind: 'cancel' })],
            occurrences: [{ occurrence: occurrence(walk), decision: { kind: 'skip' } }],
          },
          { revision: 1, notes: 'Second thoughts' },
        ),
      ),
    );

    // The review is the same record: the page sends the whole draft, so energy is now absent.
    expect(f.revision(review)).toBe(2);
    expect(f.document(review)).toMatchObject({ notes: 'Second thoughts', state: 'draft' });
    expect(f.document(review)).not.toHaveProperty('energy');
    expect(activeItems(f).map((item) => [item['decision'], item['target']])).toEqual([
      ['complete', { kind: 'action', actionId: carried.ref.id }],
      ['cancel', { kind: 'action', actionId: kept.ref.id }],
      ['skip', expect.objectContaining({ kind: 'routine_occurrence', routineId: walk.ref.id })],
    ]);
    // Removed choices stay as archived history; changed ones keep their id.
    const byId = (id: string) => f.records('review_item').find((record) => record.ref.id === id);
    const [carriedItem, movedItem, walkItem, focusItem] = first;
    expect(byId(carriedItem?.ref.id ?? '')?.localRevision).toBe(2);
    expect(byId(walkItem?.ref.id ?? '')?.document['decision']).toBe('skip');
    expect(byId(movedItem?.ref.id ?? '')?.document['archivedAt']).toBe(
      f.harness.dependencies.clock.now(),
    );
    expect(byId(focusItem?.ref.id ?? '')?.document['archivedAt']).toBeDefined();
    expect(f.events()).toEqual([
      ['review.saved', { operation: 'update' }],
      ['review_item.removed', { operation: 'update' }],
      ['review_item.removed', { operation: 'update' }],
      ['review_item.saved', { operation: 'update' }],
      ['review_item.saved', { operation: 'update' }],
      ['review_item.saved', { operation: 'create' }],
    ]);

    const view = await f.reviews.getReview('daily', today);
    expect(view?.saved?.items.map((item) => [item.decision, item.position])).toEqual([
      ['complete', 1],
      ['cancel', 2],
      ['skip', 3],
    ]);
  });

  it('refuses a save that changes nothing, and touches the review when only an item changes', async () => {
    const f = createReviewFixture();
    const project = f.seed.project();
    const input = monthly({
      projects: [{ id: project.ref.id, revision: 1, decision: 'continue' }],
      notes: 'Steady month',
    });
    accepted(await f.reviews.saveReview(input));
    expect(
      await f.refusedWithoutWrites(() => f.reviews.saveReview({ ...input, revision: 1 })),
    ).toBe('no_change');
    accepted(
      await f.reviews.saveReview({
        ...input,
        revision: 1,
        projects: [{ id: project.ref.id, revision: 1, decision: 'pause' }],
      }),
    );
    // The review's revision names the whole draft, so an item change updates it too.
    expect(f.revision(theReview(f))).toBe(2);
    expect(f.document(project)).toEqual(project.document);
  });

  it('records weekly choices in the person’s order without changing the plan', async () => {
    const f = createReviewFixture();
    const paused = f.seed.project({ title: 'Pause me' });
    const axis = f.seed.axis();
    const action = f.plan.action();
    const milestone = f.seed.milestone(f.seed.outcome().ref.id);
    const walk = f.plan.routine(dailyRule);
    accepted(
      await f.reviews.saveReview(
        weekly({
          projects: [{ id: paused.ref.id, revision: 1, decision: 'pause' }],
          axisNotes: [
            { axisId: axis.ref.id, note: 'Morning runs' },
            { axisId: f.seed.axis().ref.id, note: '   ' },
          ],
          commitments: [
            { kind: 'milestone', id: milestone.ref.id },
            { kind: 'action', id: action.ref.id },
            { kind: 'project', id: paused.ref.id },
          ],
          firstDayFocus: [
            { kind: 'routine_occurrence', occurrence: occurrence(walk) },
            { kind: 'action', actionId: action.ref.id },
          ],
        }),
      ),
    );
    expect(activeItems(f).map((item) => [item['decision'], item['target']])).toEqual([
      ['pause', { kind: 'project', projectId: paused.ref.id }],
      ['note', { kind: 'axis', axisId: axis.ref.id }],
      ['commit', { kind: 'milestone', milestoneId: milestone.ref.id }],
      ['commit', { kind: 'action', actionId: action.ref.id }],
      ['commit', { kind: 'project', projectId: paused.ref.id }],
      ['focus', expect.objectContaining({ kind: 'routine_occurrence' })],
      ['focus', { kind: 'action', actionId: action.ref.id }],
    ]);
    expect(activeItems(f)[1]?.['note']).toBe('Morning runs');
    expect(theReview(f).document).toMatchObject({ weekStart: 'monday', periodEnd: '2026-09-27' });
    expect(f.document(paused)).toEqual(paused.document);
    expect(f.records('focus_selection')).toEqual([]);
  });

  it('remembers an emptied weekly list, and forgets it once the list is omitted or chosen', async () => {
    const f = createReviewFixture();
    const action = f.plan.action();
    // The first save names both lists as empty: nothing is stored as items, and the review
    // remembers that the lists were cleared, not left to the plan.
    accepted(await f.reviews.saveReview(weekly({ commitments: [], firstDayFocus: [] })));
    expect(theReview(f).document).toMatchObject({
      clearedLists: ['commitments', 'first_day_focus'],
      state: 'draft',
    });
    expect(activeItems(f)).toEqual([]);
    expect((await f.reviews.getReview('weekly', lastWeek))?.saved?.clearedLists).toEqual([
      'commitments',
      'first_day_focus',
    ]);
    expect(f.records('focus_selection')).toEqual([]);
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.saveReview(weekly({ revision: 1, commitments: [], firstDayFocus: [] })),
      ),
    ).toBe('no_change');

    // The first day's focus is left to the plan again: only the commitments stay cleared.
    accepted(await f.reviews.saveReview(weekly({ revision: 1, commitments: [] })));
    expect(f.revision(theReview(f))).toBe(2);
    expect(theReview(f).document['clearedLists']).toEqual(['commitments']);

    // A chosen list is stored as items, never as cleared.
    accepted(
      await f.reviews.saveReview(
        weekly({ revision: 2, commitments: [{ kind: 'action', id: action.ref.id }] }),
      ),
    );
    expect(theReview(f).document).not.toHaveProperty('clearedLists');
    expect(activeItems(f).map((item) => item['decision'])).toEqual(['commit']);
    const view = await f.reviews.getReview('weekly', lastWeek);
    expect(view?.saved).not.toHaveProperty('clearedLists');

    // Emptying the chosen list again archives its item and remembers the cleared list.
    accepted(await f.reviews.saveReview(weekly({ revision: 3, commitments: [] })));
    expect(activeItems(f)).toEqual([]);
    expect(theReview(f).document['clearedLists']).toEqual(['commitments']);
  });

  it('remembers an emptied next-day focus on a daily draft, and Skip keeps it', async () => {
    const f = createReviewFixture();
    const kept = f.plan.action();
    f.plan.focus({ kind: 'action', actionId: kept.ref.id }, '2026-10-01');
    accepted(await f.reviews.saveReview(daily({ nextFocus: [] }, { notes: 'Rest tomorrow' })));
    expect(theReview(f).document).toMatchObject({
      clearedLists: ['next_focus'],
      notes: 'Rest tomorrow',
    });
    // A draft changes nothing in the plan: tomorrow's focus is still there.
    expect(f.records('focus_selection').map((record) => record.document['archivedAt'])).toEqual([
      undefined,
    ]);

    accepted(await f.reviews.skipReview({ type: 'daily', periodKey: today, revision: 1 }));
    expect(theReview(f).document).toMatchObject({
      clearedLists: ['next_focus'],
      state: 'skipped',
    });
    expect((await f.reviews.getReview('daily', today))?.saved).toMatchObject({
      state: 'skipped',
      clearedLists: ['next_focus'],
    });

    // Saving the day without naming the focus leaves it to the plan again.
    accepted(await f.reviews.saveReview(daily({}, { revision: 2, notes: 'Rest tomorrow' })));
    expect(theReview(f).document).not.toHaveProperty('clearedLists');
  });

  it('keeps a decision about a permanently deleted object when the draft is saved again', async () => {
    // Placement contract, permanent delete rule 6: the decision and its note stay.
    const f = createReviewFixture();
    const axis = f.seed.axis();
    accepted(
      await f.reviews.saveReview(
        weekly({ axisNotes: [{ axisId: axis.ref.id, note: 'Morning walks helped.' }] }),
      ),
    );
    const [noteItem] = f.records('review_item');
    if (noteItem === undefined) throw new Error('No item.');
    // What a permanent delete of the Axis leaves behind: the reference is cleared.
    f.harness.unitOfWork.seed({
      ...noteItem,
      localRevision: noteItem.localRevision + 1,
      document: {
        ...noteItem.document,
        target: {
          kind: 'deleted',
          deletedKind: 'axis',
          deletedAt: '2026-09-30T12:00:00.000Z',
        },
      },
    });
    accepted(
      await f.reviews.saveReview(
        weekly({ revision: theReview(f).localRevision, notes: 'Only the notes changed.' }),
      ),
    );
    expect(activeItems(f)).toEqual([
      expect.objectContaining({
        decision: 'note',
        note: 'Morning walks helped.',
        target: expect.objectContaining({ kind: 'deleted', deletedKind: 'axis' }) as unknown,
      }),
    ]);
  });

  it('keeps the monthly theme and the yearly direction on the review', async () => {
    const f = createReviewFixture();
    accepted(await f.reviews.saveReview(monthly({ theme: '  Rest well  ' })));
    expect(theReview(f).document).toMatchObject({ themeText: 'Rest well', state: 'draft' });
    expect(f.records('theme')).toEqual([]);

    const g = createReviewFixture();
    accepted(
      await g.reviews.saveReview(yearly({ direction: { choice: 'new', text: ' Fewer, deeper ' } })),
    );
    expect(theReview(g).document).toMatchObject({
      directionChoice: 'new',
      directionText: 'Fewer, deeper',
    });
    expect(g.records('direction')).toEqual([]);
  });

  it('refuses a target that does not exist for the owner, writing nothing', async () => {
    const f = createReviewFixture();
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.saveReview(weekly({ axisNotes: [{ axisId: unknownId, note: 'Hello' }] })),
      ),
    ).toBe('target_missing');
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.saveReview(
          monthly({ outcomes: [{ id: unknownId, revision: 1, decision: 'continue' }] }),
        ),
      ),
    ).toBe('target_missing');
  });

  it('returns the stored receipt for a repeated command id', async () => {
    const f = createReviewFixture();
    const input = monthly({ notes: 'Once' });
    const first = accepted(await f.reviews.saveReview(input, commandId(1)));
    const second = accepted(await f.reviews.saveReview(input, commandId(1)));
    expect(second).toEqual(first);
    expect(f.records('review')).toHaveLength(1);
    expect(f.harness.unitOfWork.state.events).toHaveLength(1);
  });

  it('undoes a first save by archiving the review, so the period can be reviewed again', async () => {
    const f = createReviewFixture();
    const outcome = f.seed.outcome();
    const receipt = accepted(
      await f.reviews.saveReview(
        monthly({ outcomes: [{ id: outcome.ref.id, revision: 1, decision: 'pause' }] }),
      ),
    );
    accepted(await f.undo(receipt));
    const now = f.harness.dependencies.clock.now();
    expect(theReview(f).document).toMatchObject({
      state: 'archived',
      stateBeforeArchive: 'draft',
      archivedAt: now,
    });
    expect(itemsOf(f)).toEqual([expect.objectContaining({ archivedAt: now })]);
    expect((await f.reviews.getReview('monthly', '2026-09'))?.saved).toBeNull();
    accepted(await f.reviews.saveReview(monthly({ notes: 'Again' })));
    expect(f.records('review')).toHaveLength(2);
  });

  it('undoes a save by restoring the cleared lists exactly', async () => {
    const f = createReviewFixture();
    accepted(await f.reviews.saveReview(weekly({ commitments: [] })));
    const before = theReview(f).document;
    const receipt = accepted(
      await f.reviews.saveReview(weekly({ revision: 1, firstDayFocus: [] })),
    );
    expect(theReview(f).document['clearedLists']).toEqual(['first_day_focus']);
    accepted(await f.undo(receipt));
    expect(theReview(f).document).toEqual(before);
    expect(theReview(f).document['clearedLists']).toEqual(['commitments']);
  });

  it('undoes a later save by restoring the draft exactly', async () => {
    const f = createReviewFixture();
    const outcome = f.seed.outcome();
    const project = f.seed.project();
    accepted(
      await f.reviews.saveReview(
        monthly({
          notes: 'First',
          outcomes: [{ id: outcome.ref.id, revision: 1, decision: 'pause' }],
        }),
      ),
    );
    const before = new Map(
      [...f.harness.unitOfWork.state.records.values()]
        .filter((record) => record.ref.type === 'review' || record.ref.type === 'review_item')
        .map((record) => [entityRefKey(record.ref), record.document]),
    );
    const receipt = accepted(
      await f.reviews.saveReview(
        monthly({
          revision: 1,
          notes: 'Second',
          projects: [{ id: project.ref.id, revision: 1, decision: 'complete' }],
        }),
      ),
    );
    accepted(await f.undo(receipt));
    for (const [key, document] of before)
      expect(f.harness.unitOfWork.get(key)?.document).toEqual(document);
    const created = f
      .records('review_item')
      .filter((record) => !before.has(entityRefKey(record.ref)));
    expect(created.map((record) => record.document['archivedAt'])).toEqual([
      f.harness.dependencies.clock.now(),
    ]);
  });
});

/* ───────────────────────── Skip ───────────────────────── */

describe('skipReview', () => {
  it.each([
    ['daily', today, today],
    ['weekly', lastWeek, '2026-09-27'],
    ['monthly', '2026-09', '2026-09-30'],
    ['yearly', '2025', '2025-12-31'],
  ] as const)('skips a %s review and changes nothing in the plan', async (type, key, end) => {
    const f = createReviewFixture();
    const before = [...f.harness.unitOfWork.state.records.keys()];
    const receipt = accepted(await f.reviews.skipReview({ type, periodKey: key }));
    expect(theReview(f).document).toMatchObject({
      reviewType: type,
      periodKey: key,
      periodEnd: end,
      state: 'skipped',
    });
    expect([...f.harness.unitOfWork.state.records.keys()]).toEqual([
      ...before,
      entityRefKey(theReview(f).ref),
    ]);
    expect(receipt.undo.available).toBe(true);
  });

  it('skips a new review; skipping again changes nothing', async () => {
    const f = createReviewFixture();
    accepted(await f.reviews.skipReview({ type: 'weekly', periodKey: lastWeek }));
    expect(theReview(f).document).toEqual({
      profileId: reviewProfile.profileId,
      reviewType: 'weekly',
      periodKey: lastWeek,
      periodStart: lastWeek,
      periodEnd: '2026-09-27',
      weekStart: 'monday',
      state: 'skipped',
    });
    expect(f.events()).toEqual([['review.skipped', { operation: 'create' }]]);
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.skipReview({ type: 'weekly', periodKey: lastWeek, revision: 1 }),
      ),
    ).toBe('no_change');
  });

  it('keeps a draft’s choices when it is skipped, and a later save resumes it', async () => {
    const f = createReviewFixture();
    const outcome = f.seed.outcome();
    accepted(
      await f.reviews.saveReview(
        monthly({
          notes: 'Kept',
          outcomes: [{ id: outcome.ref.id, revision: 1, decision: 'complete' }],
        }),
      ),
    );
    const [item] = f.records('review_item');
    accepted(await f.reviews.skipReview({ type: 'monthly', periodKey: '2026-09', revision: 1 }));
    expect(theReview(f).document).toMatchObject({ state: 'skipped', notes: 'Kept' });
    expect(item === undefined ? undefined : f.revision(item)).toBe(1);
    expect(f.document(outcome)).toEqual(outcome.document);

    accepted(
      await f.reviews.saveReview(
        monthly({
          revision: 2,
          notes: 'Kept',
          outcomes: [{ id: outcome.ref.id, revision: 1, decision: 'complete' }],
        }),
      ),
    );
    expect(theReview(f).document).toMatchObject({ state: 'draft' });
    expect(item === undefined ? undefined : f.revision(item)).toBe(1);
  });
});

/* ───────────────────────── Refusals ───────────────────────── */

describe('review commands refuse without writing', () => {
  it('refuses Save, Skip, and Finish on a completed review, calmly', async () => {
    const f = createReviewFixture();
    const period = { type: 'monthly', key: '2026-09', start: '2026-09-01', end: '2026-09-30' };
    f.seed.review(period as never, 'completed', {
      completedAt: f.harness.dependencies.clock.now(),
    });
    for (const run of [
      () => f.reviews.saveReview(monthly({ revision: 1 })),
      () => f.reviews.skipReview({ type: 'monthly', periodKey: '2026-09', revision: 1 }),
      () => f.reviews.finishReview(monthly({ revision: 1 })),
    ])
      expect(await f.refusedWithoutWrites(run)).toBe('review_finished');
    expect(refusalMessage(await f.reviews.saveReview(monthly({ revision: 1 })))).toBe(
      'This review is finished. Its decisions are kept in history.',
    );
  });

  it('refuses a missing, unexpected, or stale revision', async () => {
    const f = createReviewFixture();
    accepted(await f.reviews.saveReview(monthly({ notes: 'Saved' })));
    expect(await f.refusedWithoutWrites(() => f.reviews.saveReview(monthly()))).toBe(
      'review_changed',
    );
    expect(await f.refusedWithoutWrites(() => f.reviews.saveReview(monthly({ revision: 4 })))).toBe(
      'revision_conflict',
    );
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.saveReview(yearly({ revision: 1, notes: 'No such review' })),
      ),
    ).toBe('review_changed');
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.skipReview({ type: 'monthly', periodKey: '2026-09' }),
      ),
    ).toBe('review_changed');
  });

  it('refuses a period that has not started and an unsaved week that is not offered', async () => {
    const f = createReviewFixture();
    for (const input of [
      daily({}, { periodKey: '2026-10-01' }),
      weekly({ periodKey: '2026-10-05' }),
      monthly({ periodKey: '2026-10' }),
      yearly({ periodKey: '2027' }),
    ] satisfies ReviewInput[])
      expect(await f.refusedWithoutWrites(() => f.reviews.saveReview(input))).toBe('review_future');
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.skipReview({ type: 'daily', periodKey: '2026-10-01' }),
      ),
    ).toBe('review_future');
    // A Tuesday week while weeks start on Monday.
    expect(
      await f.refusedWithoutWrites(() => f.reviews.saveReview(weekly({ periodKey: '2026-09-22' }))),
    ).toBe('review_period_not_offered');
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.skipReview({ type: 'weekly', periodKey: '2026-09-22' }),
      ),
    ).toBe('review_period_not_offered');
  });
});

/* ───────────────────────── Input checks ───────────────────────── */

describe('review input is checked completely before anything is read', () => {
  const f = createReviewFixture();
  const action = f.plan.action();
  f.plan.placement(action.ref.id, onDay());
  const walk = f.plan.routine(dailyRule);
  const carry = decide(action, { kind: 'carry' });
  /** Any decision text, including ones the matrix refuses. */
  const decision = (choice: string, id: string = action.ref.id): ReviewObjectDecisionInput => ({
    id,
    revision: 1,
    decision: choice as ReviewDecisionKind,
  });
  const many = (count: number, make: (index: number) => unknown) =>
    Array.from({ length: count }, (_, index) => make(index));
  const uuid = (index: number) => `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

  const cases: readonly (readonly [string, unknown, unknown])[] = [
    ['a missing input', null, 'review_input'],
    ['a list', [], 'review_input'],
    ['an unknown type', { type: 'quarterly', periodKey: '2026' }, 'review_type'],
    ['an invalid period key', monthly({ periodKey: '2026-13' }), 'review_period'],
    ['an unexpected field', { ...weekly(), grade: 'A' }, 'review_input'],
    ['energy on a weekly review', { ...weekly(), energy: 'high' }, 'review_input'],
    ['a missing section', { type: 'weekly', periodKey: lastWeek, projects: [] }, 'review_input'],
    ['a zero revision', monthly({ revision: 0 }), 'revision'],
    ['a text revision', { ...monthly(), revision: '2' }, 'revision'],
    ['notes that are not text', { ...monthly(), notes: 42 }, 'notes_invalid'],
    ['notes that are too long', monthly({ notes: 'a'.repeat(10_001) }), 'notes_too_long'],
    [
      'an Axis note that is too long',
      weekly({ axisNotes: [{ axisId: action.ref.id, note: 'a'.repeat(2_001) }] }),
      'note_too_long',
    ],
    ['a theme that is too long', monthly({ theme: 'a'.repeat(2_001) }), 'theme_too_long'],
    [
      'a new direction without text',
      yearly({ direction: { choice: 'new' } }),
      'direction_required',
    ],
    ['an unknown direction', { ...yearly(), direction: { choice: 'later' } }, 'review_direction'],
    ['an unknown energy', { ...daily(), energy: 'sleepy' }, 'review_energy'],
    ['a malformed id', monthly({ outcomes: [decision('continue', 'not-an-id')] }), 'invalid_uuid'],
    ['a Milestone pause', monthly({ milestones: [decision('pause')] }), 'review_decision'],
    ['an Outcome focus', monthly({ outcomes: [decision('focus')] }), 'review_decision'],
    ['a Project commit as a state', weekly({ projects: [decision('commit')] }), 'review_decision'],
    ['an unknown decision', monthly({ projects: [decision('grade')] }), 'review_decision'],
    [
      'the same Project twice',
      monthly({ projects: [decision('continue'), decision('pause')] }),
      'review_duplicate',
    ],
    [
      'four commitments',
      weekly({ commitments: many(4, (index) => ({ kind: 'action', id: uuid(index) })) as never }),
      'review_commitment_limit',
    ],
    [
      'an Outcome commitment',
      { ...weekly(), commitments: [{ kind: 'outcome', id: action.ref.id }] },
      'review_input',
    ],
    [
      'the same commitment twice',
      weekly({
        commitments: [
          { kind: 'action', id: action.ref.id },
          { kind: 'action', id: action.ref.id },
        ],
      }),
      'review_duplicate',
    ],
    [
      'four first-day focus items',
      weekly({
        firstDayFocus: many(4, (index) => ({ kind: 'action', actionId: uuid(index) })) as never,
      }),
      'selection_limit',
    ],
    [
      'more decisions than a review holds',
      monthly({ outcomes: many(401, (index) => decision('continue', uuid(index))) as never }),
      'review_limit',
    ],
    ['an unexpected End Day field', daily({ ...{ extra: 1 } } as never), 'review_input'],
    [
      'an unexpected Action choice field',
      daily({ actions: [{ ...carry, note: 'x' }] as never }),
      'review_input',
    ],
    [
      'a move without a period',
      daily({ actions: [{ ...carry, decision: { kind: 'move' } }] as never }),
      'review_input',
    ],
    [
      'a carry with a period',
      daily({
        actions: [{ ...carry, decision: { kind: 'carry', period: { kind: 'day', date: today } } }],
      } as never),
      'review_input',
    ],
    [
      'a move into the past',
      daily({
        actions: [decide(action, { kind: 'move', period: { kind: 'day', date: '2026-09-29' } })],
      }),
      'move_period_past',
    ],
    [
      'an unexpected occurrence field',
      daily({
        occurrences: [
          { occurrence: { ...occurrence(walk), note: 'x' }, decision: { kind: 'skip' } },
        ] as never,
      }),
      'review_input',
    ],
    [
      'an occurrence with an invalid date',
      daily({
        occurrences: [
          {
            occurrence: { ...occurrence(walk), period: { kind: 'date', date: '2026-02-30' } },
            decision: { kind: 'skip' },
          },
        ] as never,
      }),
      'review_input',
    ],
    [
      'more Actions than End Day applies',
      daily({ actions: many(201, (index) => ({ ...carry, actionId: uuid(index) })) as never }),
      'end_day_limit',
    ],
    [
      'focus on an Action the review completes',
      daily({
        actions: [decide(action, { kind: 'complete' })],
        nextFocus: [{ kind: 'action', actionId: action.ref.id }],
      }),
      'focus_conflicts_decision',
    ],
  ];

  it.each(cases)('refuses %s', async (_name, input, reason) => {
    f.queries.calls.length = 0;
    expect(await f.refusedWithoutWrites(() => f.reviews.saveReview(input as ReviewInput))).toBe(
      reason,
    );
    expect(await f.refusedWithoutWrites(() => f.reviews.finishReview(input as ReviewInput))).toBe(
      reason,
    );
    // Nothing about reviews was read.
    expect(f.queries.calls).toEqual([]);
  });

  it.each([
    ['an unexpected field', { type: 'weekly', periodKey: lastWeek, notes: 'x' }, 'review_input'],
    ['a missing input', undefined, 'review_input'],
    ['an unknown type', { type: 'hourly', periodKey: today }, 'review_type'],
    ['an invalid period', { type: 'daily', periodKey: '2026-02-30' }, 'review_period'],
    ['an invalid revision', { type: 'daily', periodKey: today, revision: -1 }, 'revision'],
  ])('refuses a skip with %s', async (_name, input, reason) => {
    expect(await f.refusedWithoutWrites(() => f.reviews.skipReview(input as never))).toBe(reason);
  });
});
