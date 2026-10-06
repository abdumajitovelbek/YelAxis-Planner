import type { UUID } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import type { CanonicalRecordState } from './contracts';
import type { PlanningReminderDocument } from './planning-contracts';
import type { MonthlyReviewInput } from './review-contracts';
import {
  accepted,
  commandId,
  createReviewFixture,
  refusalMessage,
  reviewZone,
  type ReviewFixture,
} from './testing/review-fixtures';

/*
 * Review "Remind me to finish" reminders on saved reviews: set, replace, and turn off
 * through the Review facade, only on a saved draft or skipped review, never changed by Save, Skip,
 * or Finish, with grouped undo, command ids, stale revisions, and strict input.
 * Planning today is Wednesday 2026-09-30, 09:00 in New York.
 */

const monthly = (overrides: Partial<MonthlyReviewInput> = {}): MonthlyReviewInput => ({
  type: 'monthly',
  periodKey: '2026-09',
  outcomes: [],
  milestones: [],
  projects: [],
  ...overrides,
});

const evening = { date: '2026-10-02', time: '18:00' } as const;

const theReview = (f: ReviewFixture): CanonicalRecordState => {
  const [review] = f.records('review');
  if (review === undefined) throw new Error('No review.');
  return review;
};

const theReminder = (f: ReviewFixture): CanonicalRecordState => {
  const [reminder, ...others] = f.records('reminder');
  if (reminder === undefined || others.length > 0) throw new Error('Expected one reminder.');
  return reminder;
};

const reminderDocument = (f: ReviewFixture): PlanningReminderDocument =>
  theReminder(f).document as unknown as PlanningReminderDocument;

/** A saved monthly draft of September, at revision 1. */
async function savedDraft(f: ReviewFixture): Promise<CanonicalRecordState> {
  accepted(await f.reviews.saveReview(monthly({ notes: 'Calm month' })));
  return theReview(f);
}

describe('review reminders', () => {
  it('sets, replaces, and turns off "Remind me to finish" on a saved draft', async () => {
    const f = createReviewFixture();
    const review = await savedDraft(f);
    const receipt = accepted(
      await f.reviews.setReviewReminder({
        reviewId: review.ref.id,
        revision: 1,
        reminder: evening,
      }),
    );
    expect(receipt.canonical.map(({ ref }) => ref.type)).toEqual(['reminder']);
    expect(reminderDocument(f)).toEqual({
      reviewId: review.ref.id,
      schedule: { kind: 'at', remindAt: '2026-10-02T22:00:00.000Z', timeZone: reviewZone },
      state: 'scheduled',
    });
    // The review itself is unchanged.
    expect(f.revision(review)).toBe(1);
    const view = await f.reviews.getReview('monthly', '2026-09');
    expect(view?.saved?.reminder).toEqual({
      reminderId: theReminder(f).ref.id,
      localRevision: 1,
      kind: 'at',
      remindAt: '2026-10-02T22:00:00.000Z',
      timeZone: reviewZone,
      date: '2026-10-02',
      time: '18:00',
    });

    accepted(
      await f.reviews.setReviewReminder({
        reviewId: review.ref.id,
        revision: 1,
        reminderRevision: 1,
        reminder: { date: '2026-10-01', time: '07:30' },
      }),
    );
    expect(theReminder(f)).toMatchObject({
      localRevision: 2,
      document: { schedule: { remindAt: '2026-10-01T11:30:00.000Z' }, state: 'scheduled' },
    });

    accepted(
      await f.reviews.turnOffReviewReminder({ reviewId: review.ref.id, reminderRevision: 2 }),
    );
    expect(theReminder(f)).toMatchObject({ localRevision: 3, document: { state: 'canceled' } });
    expect((await f.reviews.getReview('monthly', '2026-09'))?.saved?.reminder).toBeUndefined();
    expect(f.events().slice(-3)).toEqual([
      ['reminder.set', { operation: 'create' }],
      ['reminder.set', { operation: 'update' }],
      ['reminder.canceled', { operation: 'update' }],
    ]);
  });

  it('accepts a skipped review, and Save, Skip, and Finish never change the reminder', async () => {
    const f = createReviewFixture();
    accepted(await f.reviews.skipReview({ type: 'monthly', periodKey: '2026-09' }));
    const review = theReview(f);
    accepted(
      await f.reviews.setReviewReminder({
        reviewId: review.ref.id,
        revision: 1,
        reminder: evening,
      }),
    );
    const scheduled = theReminder(f);

    accepted(await f.reviews.saveReview(monthly({ revision: 1, notes: 'Resumed' })));
    expect(theReminder(f)).toEqual(scheduled);
    accepted(await f.reviews.skipReview({ type: 'monthly', periodKey: '2026-09', revision: 2 }));
    expect(theReminder(f)).toEqual(scheduled);
    accepted(await f.reviews.finishReview(monthly({ revision: 3, notes: 'Done' })));
    expect(theReview(f).document).toMatchObject({ state: 'completed' });
    expect(theReminder(f)).toEqual(scheduled);
    // A finished review shows the reminder it still has, so the person can turn it off.
    expect((await f.reviews.getReview('monthly', '2026-09'))?.saved?.reminder).toMatchObject({
      localRevision: 1,
    });

    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.setReviewReminder({
          reviewId: review.ref.id,
          revision: 4,
          reminderRevision: 1,
          reminder: { date: '2026-10-03', time: '09:00' },
        }),
      ),
    ).toBe('reminder_review_not_open');
    expect(
      refusalMessage(
        await f.reviews.setReviewReminder({
          reviewId: review.ref.id,
          revision: 4,
          reminderRevision: 1,
          reminder: evening,
        }),
      ),
    ).toBe('Only a saved draft or a skipped review can get a reminder.');
    accepted(
      await f.reviews.turnOffReviewReminder({ reviewId: review.ref.id, reminderRevision: 1 }),
    );
    expect(reminderDocument(f).state).toBe('canceled');
  });

  it('undoes a set and a turn-off with PlanningApplication.undo', async () => {
    const f = createReviewFixture();
    const review = await savedDraft(f);
    const set = accepted(
      await f.reviews.setReviewReminder({
        reviewId: review.ref.id,
        revision: 1,
        reminder: evening,
      }),
    );
    expect(f.harness.unitOfWork.state.undo.at(-1)?.descriptor.commandType).toBe(
      'planning.restore_v1',
    );
    accepted(await f.undo(set));
    expect(reminderDocument(f).state).toBe('canceled');
    expect((await f.reviews.getReview('monthly', '2026-09'))?.saved?.reminder).toBeUndefined();

    accepted(
      await f.reviews.setReviewReminder({
        reviewId: review.ref.id,
        revision: 1,
        reminder: evening,
      }),
    );
    const scheduled = reminderDocument(f);
    const off = accepted(
      await f.reviews.turnOffReviewReminder({ reviewId: review.ref.id, reminderRevision: 3 }),
    );
    accepted(await f.undo(off));
    expect(reminderDocument(f)).toEqual(scheduled);
    expect(f.records('reminder')).toHaveLength(1);
  });

  it('reads a chosen time skipped by a clock change forward, in the planning zone', async () => {
    const f = createReviewFixture();
    const review = await savedDraft(f);
    accepted(
      await f.reviews.setReviewReminder({
        reviewId: review.ref.id,
        revision: 1,
        reminder: { date: '2027-03-14', time: '02:30' },
      }),
    );
    expect(reminderDocument(f).schedule).toEqual({
      kind: 'at',
      remindAt: '2027-03-14T07:30:00.000Z',
      timeZone: reviewZone,
    });
  });

  it('returns the receipt of a repeated command id and refuses stale or unknown targets', async () => {
    const f = createReviewFixture();
    const review = await savedDraft(f);
    const input = { reviewId: review.ref.id, revision: 1, reminder: evening };
    const first = accepted(await f.reviews.setReviewReminder(input, commandId(41)));
    expect(accepted(await f.reviews.setReviewReminder(input, commandId(41)))).toEqual(first);
    expect(f.records('reminder')).toHaveLength(1);

    expect(await f.refusedWithoutWrites(() => f.reviews.setReviewReminder(input))).toBe(
      'reminder_changed',
    );
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.setReviewReminder({ ...input, revision: 2, reminderRevision: 1 }),
      ),
    ).toBe('revision_conflict');
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.turnOffReviewReminder({ reviewId: review.ref.id, reminderRevision: 5 }),
      ),
    ).toBe('revision_conflict');
    const unknown = 'a0000000-0000-4000-8000-00000000dead' as UUID;
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.setReviewReminder({ ...input, reviewId: unknown }),
      ),
    ).toBe('entity_not_found');
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.turnOffReviewReminder({ reviewId: unknown, reminderRevision: 1 }),
      ),
    ).toBe('reminder_target_missing');
  });

  it.each([
    ['a malformed date', { reminder: { date: '2026-09-31', time: '18:00' } }, 'reminder_date'],
    ['a malformed time', { reminder: { date: '2026-10-02', time: '18h' } }, 'reminder_time'],
    [
      'an unexpected reminder field',
      { reminder: { ...evening, timeZone: 'UTC' } },
      'reminder_fields',
    ],
    ['minutes instead of a time', { reminder: { minutesBefore: 15 } }, 'reminder_fields'],
    ['an unexpected field', { note: 'x' }, 'reminder_input'],
    ['a malformed review id', { reviewId: 'september' }, 'reminder_input'],
    ['a malformed revision', { revision: '1' }, 'reminder_input'],
  ])('refuses %s without writing', async (_name, change, expected) => {
    const f = createReviewFixture();
    const review = await savedDraft(f);
    expect(
      await f.refusedWithoutWrites(() =>
        f.reviews.setReviewReminder({
          reviewId: review.ref.id,
          revision: 1,
          reminder: evening,
          ...change,
        } as never),
      ),
    ).toBe(expected);
  });

  it('shows no reminder for a period without a saved review', async () => {
    const f = createReviewFixture();
    const view = await f.reviews.getReview('weekly', '2026-09-21');
    expect(view?.saved).toBeNull();
    expect(f.queries.calls.map(({ method }) => method)).not.toContain('getReviewReminder');
  });
});
