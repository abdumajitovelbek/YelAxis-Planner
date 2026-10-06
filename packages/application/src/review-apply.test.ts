import {
  entityRefKey,
  type CalendarDate,
  type EntityType,
  type RecurrenceRuleV1,
} from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import type { CanonicalRecordState, CommandReceipt } from './contracts';
import type { FocusSelectionDocument } from './planning-contracts';
import type {
  DailyReviewInput,
  MonthlyReviewInput,
  WeeklyReviewInput,
  YearlyReviewInput,
} from './review-contracts';
import {
  accepted,
  commandId,
  createReviewFixture,
  refusalMessage,
  reviewProfile,
  type ReviewFixture,
} from './testing/review-fixtures';
import type { EndDayActionDecision } from './today-contracts';

const d = (value: string) => value as CalendarDate;
const today = d('2026-09-30');
const tomorrow = d('2026-10-01');
const lastWeek = d('2026-09-21');
const dailyRule: RecurrenceRuleV1 = {
  version: 1,
  kind: 'daily',
  intervalDays: 1,
  startsOn: d('2026-09-01'),
};
const onDay = (date: string = today) => ({ kind: 'day' as const, date: d(date) });
/** 14:00–15:00 in New York today. */
const afternoon = ['2026-09-30T18:00:00.000Z', '2026-09-30T19:00:00.000Z'] as const;
/** The Week this week's review plans: Monday 2026-09-28 to Sunday 2026-10-04. */
const planningWeek = { start: '2026-09-28', end: '2026-10-04', weekStart: 'monday' };

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

const daily = (
  endDay: Partial<DailyReviewInput['endDay']> = {},
  overrides: Partial<DailyReviewInput> = {},
): DailyReviewInput => ({
  type: 'daily',
  periodKey: today,
  endDay: { actions: [], occurrences: [], carryTo: tomorrow, ...endDay },
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

const decision = (record: CanonicalRecordState, choice: string) => ({
  id: record.ref.id,
  revision: record.localRevision,
  decision: choice as never,
});

const theReview = (f: ReviewFixture): CanonicalRecordState => {
  const reviews = f.records('review').filter((record) => record.document['state'] !== 'archived');
  const [review] = reviews;
  if (review === undefined || reviews.length !== 1) throw new Error('Expected one review.');
  return review;
};

/** Snapshot every record of these types, to prove Undo restores them exactly. */
function snapshot(f: ReviewFixture, types: readonly EntityType[]): Map<string, unknown> {
  return new Map(
    types
      .flatMap((type) => f.records(type))
      .map((record) => [entityRefKey(record.ref), record.document] as const),
  );
}

function expectRestored(f: ReviewFixture, before: Map<string, unknown>): void {
  for (const [key, document] of before)
    expect(f.harness.unitOfWork.get(key)?.document, key).toEqual(document);
}

function expectMinimizedEvents(f: ReviewFixture, receipt: CommandReceipt, secrets: string[]) {
  expect(
    f.harness.unitOfWork.state.receipts.get(`${receipt.ownerId}:${receipt.commandId}`),
  ).toEqual(receipt);
  for (const { event } of f.harness.unitOfWork.state.events)
    expect(Object.keys(event.payload)).toEqual(['operation']);
  const text = JSON.stringify(f.harness.unitOfWork.state.events);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

const activeFocus = (f: ReviewFixture, date: string) =>
  f
    .records('focus_selection')
    .map((record) => record.document as FocusSelectionDocument)
    .filter(
      (document) =>
        document.kind === 'day_focus' &&
        document.periodStart === date &&
        document.archivedAt === undefined,
    )
    .map((document) =>
      document.target.kind === 'action' ? document.target.actionId : 'occurrence',
    );

const activeCommitments = (f: ReviewFixture) =>
  f
    .records('focus_selection')
    .map((record) => record.document as FocusSelectionDocument)
    .filter((document) => document.kind === 'week_commitment' && document.archivedAt === undefined)
    .sort((left, right) => left.orderKey.localeCompare(right.orderKey))
    .map((document) => [
      document.target.kind === 'action'
        ? document.target.actionId
        : document.target.kind === 'project'
          ? document.target.projectId
          : document.target.kind === 'milestone'
            ? document.target.milestoneId
            : '',
      document.orderKey,
      document.periodStart,
    ]);

/* ───────────────────────── Daily ───────────────────────── */

describe('finishing a daily review', () => {
  function dailySetup() {
    const f = createReviewFixture();
    const carried = f.plan.action({ title: 'Secret carried' });
    const carriedPlacement = f.plan.placement(carried.ref.id, onDay(), {
      orderKey: '000000042000000',
    });
    const done = f.plan.action({ title: 'Secret done', state: 'scheduled' });
    const donePlacement = f.plan.placement(done.ref.id, onDay());
    const block = f.plan.block({ kind: 'action', actionId: done.ref.id }, ...afternoon);
    const later = f.plan.action({ title: 'Secret later' });
    const laterPlacement = f.plan.placement(later.ref.id, onDay());
    const walk = f.plan.routine(dailyRule, { title: 'Secret walk' });
    const input = daily(
      {
        actions: [
          decide(carried, { kind: 'carry' }),
          decide(done, { kind: 'complete' }),
          decide(later, { kind: 'move', period: { kind: 'month', date: '2026-10-15' } }),
        ],
        occurrences: [{ occurrence: occurrence(walk), decision: { kind: 'skip' } }],
        nextFocus: [{ kind: 'action', actionId: carried.ref.id }],
      },
      { notes: 'Secret note', energy: 'high' },
    );
    return {
      f,
      input,
      carried,
      carriedPlacement,
      done,
      donePlacement,
      block,
      later,
      laterPlacement,
      walk,
    };
  }

  it('applies End Day, writes the next day’s focus, and completes the review in one command', async () => {
    const { f, input, carried, carriedPlacement, done, block, laterPlacement } = dailySetup();
    const receipt = accepted(await f.reviews.finishReview(input));
    const now = f.harness.dependencies.clock.now();

    expect(f.document(carriedPlacement)).toEqual({
      ...carriedPlacement.document,
      period: onDay(tomorrow),
    });
    expect(f.document(done)).toMatchObject({ state: 'completed', completedAt: now });
    expect(f.document(block)).toMatchObject({ state: 'completed' });
    expect(f.document(laterPlacement)).toMatchObject({
      period: { kind: 'month', month: '2026-10' },
    });
    expect(f.records('routine_occurrence').map((record) => record.document['state'])).toEqual([
      'skipped',
    ]);
    expect(activeFocus(f, tomorrow)).toEqual([carried.ref.id]);

    expect(theReview(f).document).toEqual({
      profileId: reviewProfile.profileId,
      reviewType: 'daily',
      periodKey: today,
      periodStart: today,
      periodEnd: today,
      notes: 'Secret note',
      energy: 'high',
      state: 'completed',
      completedAt: now,
    });
    expect(
      f
        .records('review_item')
        .map((record) => [record.document['decision'], record.document['target']]),
    ).toEqual([
      ['carry', { kind: 'action', actionId: carried.ref.id }],
      ['complete', { kind: 'action', actionId: done.ref.id }],
      ['move', expect.objectContaining({ kind: 'action' })],
      ['skip', expect.objectContaining({ kind: 'routine_occurrence' })],
      ['focus', { kind: 'action', actionId: carried.ref.id }],
    ]);

    expect(f.events()).toEqual([
      ['planning.placed', { operation: 'update' }],
      ['action.completed', { operation: 'update' }],
      ['time_block.completed', { operation: 'update' }],
      ['planning.placed', { operation: 'update' }],
      ['routine_occurrence.skipped', { operation: 'create' }],
      ['focus.added', { operation: 'create' }],
      ['review.finished', { operation: 'create' }],
      ...Array.from({ length: 5 }, () => ['review_item.saved', { operation: 'create' }]),
    ]);
    expect(f.harness.unitOfWork.state.receipts.size).toBe(1);
    expect(f.harness.unitOfWork.state.undo).toHaveLength(1);
    expect(f.harness.unitOfWork.state.undo[0]?.descriptor.commandType).toBe('planning.restore_v1');
    expectMinimizedEvents(f, receipt, ['Secret']);
  });

  it('restores the plan and the review with one Undo', async () => {
    const setup = dailySetup();
    const { f, input } = setup;
    const before = snapshot(f, ['action', 'planning_placement', 'time_block']);
    const receipt = accepted(await f.reviews.finishReview(input));
    accepted(await f.undo(receipt));
    const now = f.harness.dependencies.clock.now();

    expectRestored(f, before);
    expect(f.records('routine_occurrence').map((record) => record.document['state'])).toEqual([
      'planned',
    ]);
    expect(activeFocus(f, tomorrow)).toEqual([]);
    // The review was created by Finish, so Undo archives it and the day can be reviewed again.
    expect(f.records('review')[0]?.document).toMatchObject({
      state: 'archived',
      stateBeforeArchive: 'completed',
      archivedAt: now,
    });
    expect(f.records('review_item').every((record) => record.document['archivedAt'] === now)).toBe(
      true,
    );
    const view = await f.reviews.getReview('daily', today);
    expect(view?.saved).toBeNull();
    expect(view?.editable).toBe(true);
  });

  it('finishes a saved draft, and Undo returns it to the draft', async () => {
    const { f, input, carried } = dailySetup();
    accepted(
      await f.reviews.saveReview(
        daily({ actions: [decide(carried, { kind: 'cancel' })] }, { notes: 'Draft note' }),
      ),
    );
    const draft = theReview(f);
    const [draftItem] = f.records('review_item');
    const receipt = accepted(await f.reviews.finishReview({ ...input, revision: 1 }));
    expect(f.document(draft)).toMatchObject({ state: 'completed', notes: 'Secret note' });
    // The saved choice changed from cancel to carry: the same item is updated.
    expect(draftItem === undefined ? undefined : f.document(draftItem)).toMatchObject({
      decision: 'carry',
    });
    accepted(await f.undo(receipt));
    expect(f.document(draft)).toEqual(draft.document);
    expect(draftItem === undefined ? undefined : f.document(draftItem)).toEqual(
      draftItem?.document,
    );
  });

  it('clears the next day’s focus when it is emptied, and the review remembers it', async () => {
    const f = createReviewFixture();
    const kept = f.plan.action();
    f.plan.focus({ kind: 'action', actionId: kept.ref.id }, tomorrow);
    accepted(await f.reviews.saveReview(daily({ nextFocus: [] })));
    expect(activeFocus(f, tomorrow)).toEqual([kept.ref.id]);
    expect((await f.reviews.getReview('daily', today))?.saved?.clearedLists).toEqual([
      'next_focus',
    ]);

    const receipt = accepted(
      await f.reviews.finishReview(daily({ nextFocus: [] }, { revision: 1 })),
    );
    expect(activeFocus(f, tomorrow)).toEqual([]);
    expect(theReview(f).document).toMatchObject({
      state: 'completed',
      clearedLists: ['next_focus'],
    });
    accepted(await f.undo(receipt));
    expect(activeFocus(f, tomorrow)).toEqual([kept.ref.id]);
    expect(theReview(f).document).toMatchObject({ state: 'draft', clearedLists: ['next_focus'] });
  });

  it('writes the energy and the note even when End Day has no choices', async () => {
    const f = createReviewFixture();
    accepted(await f.reviews.finishReview(daily({}, { energy: 'low', notes: 'Quiet day' })));
    expect(theReview(f).document).toMatchObject({
      state: 'completed',
      energy: 'low',
      notes: 'Quiet day',
    });
    expect(f.events()).toEqual([['review.finished', { operation: 'create' }]]);
  });

  it('skips, resumes, and then finishes a review', async () => {
    const { f, input } = dailySetup();
    accepted(await f.reviews.skipReview({ type: 'daily', periodKey: today }));
    accepted(await f.reviews.saveReview(daily({}, { revision: 1, notes: 'Back to it' })));
    expect(theReview(f).document['state']).toBe('draft');
    accepted(await f.reviews.finishReview({ ...input, revision: 2 }));
    expect(theReview(f).document).toMatchObject({ state: 'completed', notes: 'Secret note' });
  });

  it('applies the decisions exactly once', async () => {
    const { f, input, done } = dailySetup();
    const first = accepted(await f.reviews.finishReview(input, commandId(7)));
    const events = f.harness.unitOfWork.state.events.length;
    // A repeated command id returns its receipt, even though the review is now completed.
    expect(accepted(await f.reviews.finishReview(input, commandId(7)))).toEqual(first);
    expect(f.harness.unitOfWork.state.events).toHaveLength(events);
    // A new Finish of the completed review is refused and changes nothing.
    expect(
      await f.refusedWithoutWrites(() => f.reviews.finishReview({ ...input, revision: 1 })),
    ).toBe('review_finished');
    expect(f.revision(done)).toBe(2);
  });

  it('requires the End Day carry date, and refuses one the day has moved past', async () => {
    const { f, input } = dailySetup();
    const withoutCarry: DailyReviewInput['endDay'] = {
      actions: input.endDay.actions,
      occurrences: input.endDay.occurrences,
    };
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.finishReview({ ...input, endDay: withoutCarry }),
      ),
    ).toBe('invalid_time');
    // Save ignores the carry date.
    accepted(await f.reviews.saveReview({ ...input, endDay: withoutCarry }));
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.finishReview({ ...input, endDay: { ...input.endDay, carryTo: '2026-10-02' } }),
      ),
    ).toBe('end_day_day_changed');
    expect(
      refusalMessage(
        await f.reviews.finishReview({ ...input, endDay: { ...input.endDay, carryTo: today } }),
      ),
    ).toBe('The day changed. Review your choices again.');
  });

  it('refuses a stale revision or a changed plan without partial writes', async () => {
    const { f, input, carried, later } = dailySetup();
    // The first choice would apply, but a later Action's revision is stale.
    const stale = {
      ...input,
      endDay: {
        ...input.endDay,
        actions: [
          decide(carried, { kind: 'carry' }),
          { ...decide(later, { kind: 'carry' }), revision: 9 },
        ],
      },
    };
    expect(await f.refusedWithoutWrites(() => f.reviews.finishReview(stale))).toBe(
      'revision_conflict',
    );
    // The plan changed after the review was read: the Action is now planned for tomorrow.
    const moved = f.plan.action();
    f.plan.placement(moved.ref.id, onDay(tomorrow));
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.finishReview(daily({ actions: [decide(moved, { kind: 'carry' })] })),
      ),
    ).toBe('not_on_day');
  });
});

/* ───────────────────────── Weekly ───────────────────────── */

describe('finishing a weekly review', () => {
  function weeklySetup() {
    const f = createReviewFixture();
    const pause = f.seed.project({ title: 'Secret pause' });
    const keep = f.seed.project({ title: 'Secret keep' });
    const axis = f.seed.axis({ title: 'Secret axis' });
    const dropped = f.plan.action({ title: 'Secret dropped' });
    const chosen = f.plan.action({ title: 'Secret chosen' });
    f.plan.placement(chosen.ref.id, onDay());
    const droppedCommitment = f.seed.commitment(
      { kind: 'action', actionId: dropped.ref.id },
      planningWeek,
      '000000000000001',
    );
    const keptCommitment = f.seed.commitment(
      { kind: 'project', projectId: keep.ref.id },
      planningWeek,
      '000000000000005',
    );
    const input = weekly({
      notes: 'Secret week',
      projects: [decision(pause, 'pause'), decision(keep, 'continue')],
      axisNotes: [{ axisId: axis.ref.id, note: 'Secret support' }],
      commitments: [
        { kind: 'action', id: chosen.ref.id },
        { kind: 'project', id: keep.ref.id },
      ],
      firstDayFocus: [{ kind: 'action', actionId: chosen.ref.id }],
    });
    return { f, input, pause, keep, axis, dropped, chosen, droppedCommitment, keptCommitment };
  }

  it('pauses, replaces the planning Week’s commitments, and sets the first day’s focus', async () => {
    const { f, input, pause, keep, chosen, droppedCommitment } = weeklySetup();
    const receipt = accepted(await f.reviews.finishReview(input));

    expect(f.document(pause)).toMatchObject({ state: 'paused' });
    expect(f.document(keep)).toMatchObject({ state: 'active' });
    // The chosen order: the new Action first, then the kept Project (renumbered).
    expect(activeCommitments(f)).toEqual([
      [chosen.ref.id, '000000000000001', '2026-09-28'],
      [keep.ref.id, '000000000000002', '2026-09-28'],
    ]);
    expect(f.document(droppedCommitment)).toHaveProperty('archivedAt');
    // The planning Week started on Monday, so the first day's focus is today.
    expect(activeFocus(f, today)).toEqual([chosen.ref.id]);
    expect(theReview(f).document).toMatchObject({ state: 'completed', notes: 'Secret week' });
    expect(f.records('review_item').map((record) => record.document['decision'])).toEqual([
      'pause',
      'continue',
      'note',
      'commit',
      'commit',
      'focus',
    ]);
    expect(f.events().map(([type]) => type)).toEqual([
      'project.transitioned',
      'planning.week_commitment_removed',
      'planning.week_commitment_reordered',
      'planning.week_commitment_added',
      'focus.added',
      'review.finished',
      ...Array.from({ length: 6 }, () => 'review_item.saved'),
    ]);
    expectMinimizedEvents(f, receipt, ['Secret']);
  });

  it('restores the plan and the review with one Undo', async () => {
    const { f, input } = weeklySetup();
    const before = snapshot(f, ['project', 'focus_selection']);
    const receipt = accepted(await f.reviews.finishReview(input));
    accepted(await f.undo(receipt));
    expectRestored(f, before);
    expect(activeCommitments(f).map(([, key]) => key)).toEqual([
      '000000000000001',
      '000000000000005',
    ]);
    expect(activeFocus(f, today)).toEqual([]);
    expect(f.records('review')[0]?.document['state']).toBe('archived');
  });

  it('keeps the chosen order beside an onboarding commitment, and Undo restores its key', async () => {
    const f = createReviewFixture();
    const starter = f.plan.action({ title: 'Secret starter' });
    const chosen = f.plan.action({ title: 'Secret chosen' });
    // Onboarding writes the starter Week commitment with the key `onboarding-01`.
    const onboarding = f.seed.commitment(
      { kind: 'action', actionId: starter.ref.id },
      planningWeek,
      'onboarding-01',
    );
    const receipt = accepted(
      await f.reviews.finishReview(
        weekly({
          commitments: [
            { kind: 'action', id: starter.ref.id },
            { kind: 'action', id: chosen.ref.id },
          ],
        }),
      ),
    );
    expect(activeCommitments(f)).toEqual([
      [starter.ref.id, '000000000000001', '2026-09-28'],
      [chosen.ref.id, '000000000000002', '2026-09-28'],
    ]);
    accepted(await f.undo(receipt));
    expect(f.document(onboarding)).toEqual(onboarding.document);
    expect(activeCommitments(f)).toEqual([[starter.ref.id, 'onboarding-01', '2026-09-28']]);
  });

  it('finishes a draft that emptied the commitments and the first day’s focus by clearing both', async () => {
    const { f, chosen, droppedCommitment, keptCommitment } = weeklySetup();
    f.plan.focus({ kind: 'action', actionId: chosen.ref.id }, today);
    accepted(await f.reviews.saveReview(weekly({ commitments: [], firstDayFocus: [] })));
    // Saving applied nothing.
    expect(activeCommitments(f)).toHaveLength(2);
    expect(activeFocus(f, today)).toEqual([chosen.ref.id]);
    expect((await f.reviews.getReview('weekly', lastWeek))?.saved?.clearedLists).toEqual([
      'commitments',
      'first_day_focus',
    ]);

    const before = snapshot(f, ['focus_selection']);
    const receipt = accepted(
      await f.reviews.finishReview(weekly({ revision: 1, commitments: [], firstDayFocus: [] })),
    );
    expect(activeCommitments(f)).toEqual([]);
    expect(f.document(droppedCommitment)).toHaveProperty('archivedAt');
    expect(f.document(keptCommitment)).toHaveProperty('archivedAt');
    expect(activeFocus(f, today)).toEqual([]);
    expect(theReview(f).document).toMatchObject({
      state: 'completed',
      clearedLists: ['commitments', 'first_day_focus'],
    });
    expect(f.records('review_item')).toEqual([]);

    accepted(await f.undo(receipt));
    expectRestored(f, before);
    expect(theReview(f).document).toMatchObject({
      state: 'draft',
      clearedLists: ['commitments', 'first_day_focus'],
    });
  });

  it('leaves the commitments and the first day’s focus alone when they are not chosen', async () => {
    const { f, pause, keep, droppedCommitment, keptCommitment } = weeklySetup();
    accepted(
      await f.reviews.finishReview(
        weekly({ projects: [decision(pause, 'continue'), decision(keep, 'continue')] }),
      ),
    );
    expect(f.document(droppedCommitment)).toEqual(droppedCommitment.document);
    expect(f.document(keptCommitment)).toEqual(keptCommitment.document);
    expect(f.document(pause)).toEqual(pause.document);
    expect(activeFocus(f, today)).toEqual([]);
    expect(f.events().map(([type]) => type)).toEqual([
      'review.finished',
      'review_item.saved',
      'review_item.saved',
    ]);
  });

  it('refuses a transition the rules do not allow, and a stale Project, without writing', async () => {
    const { f, input } = weeklySetup();
    const finished = f.seed.project({ state: 'completed' });
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.finishReview({ ...input, projects: [decision(finished, 'pause')] }),
      ),
    ).toBe('not_allowed');
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.finishReview({
          ...input,
          projects: [{ ...decision(finished, 'continue'), revision: 3 }],
        }),
      ),
    ).toBe('revision_conflict');
    // A commitment target that is archived follows the planning rule.
    const archived = f.plan.action({ state: 'archived' });
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.finishReview({
          ...input,
          commitments: [{ kind: 'action', id: archived.ref.id }],
        }),
      ),
    ).toBe('archived_target');
  });

  it('finishes a saved draft after a first-weekday change, planning the week after it', async () => {
    const { f, pause } = weeklySetup();
    accepted(await f.reviews.saveReview(weekly({ projects: [decision(pause, 'continue')] })));
    const sundays = f.reviewsFor({ weekStart: 'sunday' });
    const chosen = f.plan.action();
    accepted(
      await sundays.finishReview(
        weekly({
          revision: 1,
          projects: [decision(pause, 'continue')],
          commitments: [{ kind: 'action', id: chosen.ref.id }],
        }),
      ),
    );
    // The reviewed Monday week keeps its period; the plan is the Sunday week after it.
    expect(theReview(f).document).toMatchObject({ periodKey: lastWeek, weekStart: 'monday' });
    const commitment = f
      .records('focus_selection')
      .map((record) => record.document as FocusSelectionDocument)
      .find(
        (document) =>
          document.target.kind === 'action' && document.target.actionId === chosen.ref.id,
      );
    expect(commitment).toMatchObject({
      periodStart: '2026-09-27',
      periodEnd: '2026-10-03',
      weekStart: 'sunday',
    });
  });
});

/* ───────────────────────── Monthly ───────────────────────── */

describe('finishing a monthly review', () => {
  function monthlySetup() {
    const f = createReviewFixture();
    const achieved = f.seed.outcome({ title: 'Secret achieved' });
    const archived = f.seed.outcome();
    const alreadyPaused = f.seed.outcome({ state: 'paused' });
    const milestone = f.seed.milestone(achieved.ref.id);
    const paused = f.seed.project();
    const kept = f.seed.project({ state: 'paused' });
    const theme = f.seed.theme('2026-10', 'Old theme');
    const input = monthly({
      outcomes: [
        decision(achieved, 'complete'),
        decision(archived, 'archive'),
        decision(alreadyPaused, 'pause'),
      ],
      milestones: [decision(milestone, 'cancel')],
      projects: [decision(paused, 'pause'), decision(kept, 'continue')],
      theme: 'Secret theme',
    });
    return { f, input, achieved, archived, alreadyPaused, milestone, paused, kept, theme };
  }

  it('applies Outcome, Milestone, and Project decisions and the next month’s theme', async () => {
    const { f, input, achieved, archived, alreadyPaused, milestone, paused, kept, theme } =
      monthlySetup();
    const receipt = accepted(await f.reviews.finishReview(input));
    const now = f.harness.dependencies.clock.now();
    expect(f.document(achieved)).toMatchObject({ state: 'achieved' });
    expect(f.document(archived)).toMatchObject({
      state: 'archived',
      stateBeforeArchive: 'active',
      archivedAt: now,
    });
    // Already paused: nothing to change.
    expect(f.document(alreadyPaused)).toEqual(alreadyPaused.document);
    expect(f.document(milestone)).toMatchObject({ state: 'canceled' });
    expect(f.document(paused)).toMatchObject({ state: 'paused' });
    expect(f.document(kept)).toEqual(kept.document);
    expect(f.document(theme)).toMatchObject({ month: '2026-10', text: 'Secret theme' });
    expect(theReview(f).document).toMatchObject({ state: 'completed', themeText: 'Secret theme' });
    expect(f.events().map(([type]) => type)).toEqual([
      'outcome.transitioned',
      'outcome.archived',
      'milestone.transitioned',
      'project.transitioned',
      'planning.month_theme_set',
      'review.finished',
      ...Array.from({ length: 6 }, () => 'review_item.saved'),
    ]);
    expectMinimizedEvents(f, receipt, ['Secret']);
  });

  it('restores every object and the theme with one Undo', async () => {
    const { f, input } = monthlySetup();
    const before = snapshot(f, ['outcome', 'milestone', 'project', 'theme']);
    const receipt = accepted(await f.reviews.finishReview(input));
    accepted(await f.undo(receipt));
    expectRestored(f, before);
  });

  it('creates the planning month’s theme, and leaves an equal theme alone', async () => {
    const f = createReviewFixture();
    const receipt = accepted(await f.reviews.finishReview(monthly({ theme: '  Rest well ' })));
    expect(f.records('theme').map((record) => record.document)).toEqual([
      expect.objectContaining({ month: '2026-10', text: 'Rest well' }),
    ]);
    accepted(await f.undo(receipt));
    expect(f.records('theme')[0]?.document).toHaveProperty('archivedAt');

    const g = createReviewFixture();
    const theme = g.seed.theme('2026-10', 'Rest well');
    accepted(await g.reviews.finishReview(monthly({ theme: 'Rest well' })));
    expect(g.revision(theme)).toBe(1);
    // A blank theme leaves the month's theme unchanged too.
    const h = createReviewFixture();
    accepted(await h.reviews.finishReview(monthly({ theme: '   ' })));
    expect(h.records('theme')).toEqual([]);
  });

  it('rolls everything back when one decision is not allowed', async () => {
    const { f, input } = monthlySetup();
    const finished = f.seed.milestone(f.seed.outcome().ref.id, { state: 'completed' });
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.finishReview({ ...input, milestones: [decision(finished, 'cancel')] }),
      ),
    ).toBe('not_allowed');
  });
});

/* ───────────────────────── Yearly ───────────────────────── */

describe('finishing a yearly review', () => {
  it('continues the reviewed year’s direction and applies Outcome decisions', async () => {
    const f = createReviewFixture();
    f.seed.direction('2025', 'Secret foundations');
    const outcome = f.seed.outcome();
    const receipt = accepted(
      await f.reviews.finishReview(
        yearly({
          notes: 'Secret retrospective',
          outcomes: [decision(outcome, 'cancel')],
          direction: { choice: 'continue' },
        }),
      ),
    );
    expect(f.document(outcome)).toMatchObject({ state: 'abandoned' });
    expect(
      f
        .records('direction')
        .map((record) => record.document)
        .find((document) => document['year'] === '2026'),
    ).toMatchObject({ text: 'Secret foundations' });
    expect(theReview(f).document).toMatchObject({
      state: 'completed',
      directionChoice: 'continue',
      notes: 'Secret retrospective',
    });
    expect(theReview(f).document).not.toHaveProperty('directionText');
    expect(f.events().map(([type]) => type)).toEqual([
      'outcome.transitioned',
      'planning.year_direction_set',
      'review.finished',
      'review_item.saved',
    ]);
    expectMinimizedEvents(f, receipt, ['Secret']);

    accepted(await f.undo(receipt));
    expect(f.document(outcome)).toEqual(outcome.document);
    expect(
      f
        .records('direction')
        .map((record) => record.document)
        .find((document) => document['year'] === '2026'),
    ).toHaveProperty('archivedAt');
  });

  it('sets a new direction, and an outdated one changes no plan record', async () => {
    const f = createReviewFixture();
    const current = f.seed.direction('2026', 'Old direction');
    accepted(
      await f.reviews.finishReview(yearly({ direction: { choice: 'new', text: '  Go slower ' } })),
    );
    expect(f.document(current)).toMatchObject({ text: 'Go slower' });
    expect(theReview(f).document).toMatchObject({
      directionChoice: 'new',
      directionText: 'Go slower',
    });

    const g = createReviewFixture();
    const kept = g.seed.direction('2025', 'Kept');
    accepted(await g.reviews.finishReview(yearly({ direction: { choice: 'outdated' } })));
    expect(g.records('direction')).toEqual([kept]);
    expect(theReview(g).document).toMatchObject({ directionChoice: 'outdated' });
  });

  it('refuses to continue a direction that does not exist, and rolls back the rest', async () => {
    const f = createReviewFixture();
    const outcome = f.seed.outcome();
    const input = yearly({
      outcomes: [decision(outcome, 'complete')],
      direction: { choice: 'continue' },
    });
    expect(await f.refusedWithoutWrites(() => f.reviews.finishReview(input))).toBe(
      'direction_missing',
    );
    // Saving that choice as a draft is fine: nothing is applied yet.
    accepted(await f.reviews.saveReview(input));
    expect(f.document(outcome)).toEqual(outcome.document);
  });

  it('leaves an equal planning-year direction alone', async () => {
    const f = createReviewFixture();
    f.seed.direction('2025', 'Same');
    const planning = f.seed.direction('2026', 'Same');
    accepted(await f.reviews.finishReview(yearly({ direction: { choice: 'continue' } })));
    expect(f.revision(planning)).toBe(1);
  });
});
