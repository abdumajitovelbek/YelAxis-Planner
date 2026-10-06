/**
 * Review "Remind me to finish" reminders on saved reviews: a saved draft or a skipped
 * review may hold one reminder at a chosen date and time in the planning zone. Setting, replacing,
 * and turning it off are one `executeCommand` each with expected revisions, a `reminder.set` or
 * `reminder.canceled` event carrying `{ operation }` only, a receipt, and a grouped
 * `planning.restore_v1` undo (applied with `PlanningApplication.undo`). Saving, skipping, and
 * finishing a review never change its reminder. The notification application owns delivery.
 */
import {
  checkReviewAcceptsReminder,
  createEntityRef,
  parseReviewReminderRequest,
  resolveReviewReminder,
} from '@yelaxis/domain';

import type { ApplicationResult, CommandReceipt } from './contracts';
import {
  parseSetReminderInput,
  parseTurnOffReminderInput,
  planSetReminder,
  planTurnOffReminder,
  prepareSetReminder,
  prepareTurnOffReminder,
  reminderChanged,
  reminderEventTypes,
  reminderTargetMissing,
  reminderView,
} from './planning-reminders';
import { rejected } from './planning-scheduling-support';
import type { ReviewApplication, ReviewView } from './review-contracts';
import { reviewDocumentOf, type ReviewKit } from './review-kit';

/** A review view whose saved review carries its scheduled reminder, when it has one. */
export async function withReviewReminder(
  kit: ReviewKit,
  view: ReviewView | null,
): Promise<ReviewView | null> {
  if (view === null || view.saved === null) return view;
  const ownerId = await kit.ownerId();
  const reminder = reminderView(await kit.queries.getReviewReminder(ownerId, view.saved.reviewId));
  return reminder === undefined ? view : { ...view, saved: { ...view.saved, reminder } };
}

async function setReviewReminder(
  kit: ReviewKit,
  raw: unknown,
  commandId: Parameters<ReviewApplication['setReviewReminder']>[1],
): Promise<ApplicationResult<CommandReceipt>> {
  const input = parseSetReminderInput(raw, 'reviewId', parseReviewReminderRequest);
  if (!input.ok) return rejected(input.error);
  const { ownerId, profile } = await kit.session();
  const reviewRef = createEntityRef('review', input.value.targetId, ownerId);
  const current = await kit.queries.getReviewReminder(ownerId, reviewRef.id);
  const prepared = prepareSetReminder(current, input.value.reminderRevision);
  // The review's expected revision also refuses a review that does not exist.
  return kit.run(
    ownerId,
    commandId,
    reminderEventTypes.set,
    [{ ref: reviewRef, revision: input.value.revision }, ...prepared.expected],
    async ({ records }) => {
      if (!prepared.check.ok) return prepared.check;
      const review = await records.read(reviewRef);
      if (review === null) return reminderChanged();
      const accepts = checkReviewAcceptsReminder({ state: reviewDocumentOf(review).state });
      if (!accepts.ok) return accepts;
      const schedule = resolveReviewReminder(input.value.request, {
        timeZone: profile.planningTimeZone,
      });
      if (!schedule.ok) return schedule;
      return planSetReminder({
        records,
        ownerId,
        current,
        target: { reviewId: reviewRef.id },
        schedule: schedule.value,
        nextId: kit.nextId,
      });
    },
  );
}

async function turnOffReviewReminder(
  kit: ReviewKit,
  raw: unknown,
  commandId: Parameters<ReviewApplication['turnOffReviewReminder']>[1],
): Promise<ApplicationResult<CommandReceipt>> {
  const input = parseTurnOffReminderInput(raw, 'reviewId');
  if (!input.ok) return rejected(input.error);
  const ownerId = await kit.ownerId();
  const reviewRef = createEntityRef('review', input.value.targetId, ownerId);
  const current = await kit.queries.getReviewReminder(ownerId, reviewRef.id);
  const prepared = prepareTurnOffReminder(current, input.value.reminderRevision);
  return kit.run(
    ownerId,
    commandId,
    reminderEventTypes.canceled,
    prepared.expected,
    async ({ records }) => {
      if ((await records.read(reviewRef)) === null) return reminderTargetMissing();
      if (!prepared.check.ok) return prepared.check;
      return planTurnOffReminder(records, prepared.check.value, { reviewId: reviewRef.id });
    },
  );
}

export function createReviewReminderMethods(
  kit: ReviewKit,
): Pick<ReviewApplication, 'setReviewReminder' | 'turnOffReviewReminder'> {
  return {
    setReviewReminder: (input, commandId) => setReviewReminder(kit, input, commandId),
    turnOffReviewReminder: (input, commandId) => turnOffReviewReminder(kit, input, commandId),
  };
}
