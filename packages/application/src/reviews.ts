import { createSerialQueue, serializeMethods, type SerialQueue } from './planning-kit';
import type { ApplicationDependencies } from './ports';
import { finishReview } from './review-apply';
import { saveReview, skipReview } from './review-commands';
import type { ReviewApplication, ReviewQueryPort } from './review-contracts';
import { createReviewKit } from './review-kit';
import { createReviewReads } from './review-read';
import { createReviewReminderMethods, withReviewReminder } from './review-reminders';

/**
 * Review manual Reviews facade. Every call is serialized on the queue the composition root
 * shares with the Action, planning, alignment, and Today facades, because the browser owns one
 * SQLite worker connection; each command keeps its own application-owned transaction.
 */
export function createReviewApplication(
  dependencies: ApplicationDependencies,
  queries: ReviewQueryPort,
  options: { readonly queue?: SerialQueue } = {},
): ReviewApplication {
  const kit = createReviewKit(dependencies, queries);
  const reads = createReviewReads(kit);
  const application: ReviewApplication = {
    ...reads,
    // A saved review also shows its "Remind me to finish" reminder.
    getReview: async (type, periodKey) =>
      withReviewReminder(kit, await reads.getReview(type, periodKey)),
    saveReview: (input, commandId) => saveReview(kit, input, commandId),
    skipReview: (input, commandId) => skipReview(kit, input, commandId),
    finishReview: (input, commandId) => finishReview(kit, input, commandId),
    ...createReviewReminderMethods(kit),
  };
  return serializeMethods(application, options.queue ?? createSerialQueue());
}
