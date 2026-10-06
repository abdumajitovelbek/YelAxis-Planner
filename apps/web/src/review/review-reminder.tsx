import { message as uiMessage } from '../messages';
/**
 * "Remind me to finish this review": a saved draft or skipped review may hold one
 * reminder at a chosen date and time in the planning zone; a finished review that still has one
 * shows it with "Turn off reminder". Definitions stay saved independently of browser permission;
 * opt-in delivery while open is coordinated by the notification application.
 * Setting and turning off are one command each with Undo (`PlanningApplication.undo`).
 * Reminder commands do not change the review's revision; the page re-reads the review after each.
 *
 * Undo follows the last command only: a reminder command ends the page's Undo (`onCommand`), and a
 * page command ends this section's (`resetKey`). Undo of the command that created a review
 * archives it, and a reminder set since would then stay scheduled out of reach, so that Undo is
 * never offered once a reminder command has run.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import type { PlanProfile, ReminderView, SavedReview } from '@yelaxis/application';
import type { CalendarDate } from '@yelaxis/domain';

import { formatDate, formatWallTime } from '../plan/format';
import { useCommandRunner, usePlanning, useReviewApplication } from '../plan/planning-context';
import { reminderSavedCopy } from '../plan/scheduling-dialogs';
import { isCalendarDate, isWallTime } from '../plan/timeline';

import './review.css';

type ReminderResult = 'saved' | 'off' | 'undone' | 'unchanged';

const resultText: Readonly<Record<ReminderResult, string>> = {
  saved: uiMessage('plan.routines.1600'),
  off: uiMessage('plan.routines.1599'),
  undone: uiMessage('review.review-reminder.1993'),
  unchanged: uiMessage('review.review-reminder.1994'),
};

interface ReminderErrors {
  readonly date?: string;
  readonly time?: string;
}

/** A time input's value as a wall time (a browser may add seconds). */
const wallTimeOf = (value: string): string => value.slice(0, 5);

/**
 * The reminder's date and time in words, e.g. "Friday, October 2, 2026 at 18:00", with its zone
 * when it was saved in another planning zone than the current one.
 */
function reminderWhen(reminder: ReminderView, profile: PlanProfile): string {
  const zone =
    reminder.timeZone === profile.planningTimeZone
      ? ''
      : ` (${reminder.timeZone.replace(/_/gu, ' ')})`;
  return uiMessage('review.review-reminder.1995', {
    value0: formatDate(reminder.date, 'long'),
    value1: formatWallTime(reminder.time, profile.timeFormat),
    value2: zone,
  });
}

/** Check the fields in words; `input` only when both are valid. */
function checkReminder(
  date: string,
  time: string,
): {
  readonly errors: ReminderErrors;
  readonly input?: { readonly date: string; readonly time: string };
} {
  const errors: ReminderErrors = {
    ...(isCalendarDate(date) ? {} : { date: uiMessage('plan.scheduling-dialogs.1659') }),
    ...(isWallTime(wallTimeOf(time)) ? {} : { time: uiMessage('plan.scheduling-dialogs.1660') }),
  };
  return errors.date === undefined && errors.time === undefined
    ? { errors, input: { date, time: wallTimeOf(time) } }
    : { errors };
}

/**
 * The Reminder section of a saved review. An open review (draft or skipped) offers the date and
 * time fields with "Save reminder", and "Turn off reminder" when one is set; a finished review
 * shows only a reminder it still has, with "Turn off reminder". Each command reports its result in
 * a status message, with Undo, and moves focus there; a refusal is shown here in calm words.
 */
export function ReviewReminderSection({
  onCommand,
  pageBusy,
  profile,
  resetKey,
  saved,
  today,
}: {
  readonly saved: SavedReview;
  readonly profile: PlanProfile;
  /** Planning today: the date a new reminder starts from. */
  readonly today: CalendarDate;
  /** The page is running one of its own commands or reading the review again. */
  readonly pageBusy: boolean;
  /**
   * Changes whenever the page runs one of its own commands, which ends this section's result and
   * its Undo.
   */
  readonly resetKey: number;
  /** A reminder command is starting: the page ends its own last result and its Undo. */
  readonly onCommand: () => void;
}): ReactNode {
  const reviews = useReviewApplication();
  const planning = usePlanning();
  const runner = useCommandRunner();
  const id = useId();
  const reminder = saved.reminder;
  const open = saved.state === 'draft' || saved.state === 'skipped';
  const busy = runner.busy || pageBusy;

  const [date, setDate] = useState<string>(reminder?.date ?? today);
  const [time, setTime] = useState<string>(reminder?.time.slice(0, 5) ?? '');
  const [errors, setErrors] = useState<ReminderErrors>({});
  const [result, setResult] = useState<{
    readonly kind: ReminderResult;
    readonly key: number;
  } | null>(null);
  const results = useRef(0);
  const [errorFocus, setErrorFocus] = useState(0);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);

  // The fields show the saved reminder whenever it changes (set, replaced, or brought back by Undo).
  const reminderKey =
    reminder === undefined ? null : `${reminder.reminderId}:${String(reminder.localRevision)}`;
  const [shownKey, setShownKey] = useState(reminderKey);
  if (shownKey !== reminderKey) {
    setShownKey(reminderKey);
    if (reminder !== undefined) {
      setDate(reminder.date);
      setTime(reminder.time.slice(0, 5));
      setErrors({});
    }
  }
  // A command of the page ends this section's last result, refusal, and Undo.
  const [seenReset, setSeenReset] = useState(resetKey);
  if (seenReset !== resetKey) {
    setSeenReset(resetKey);
    setResult(null);
    runner.clearError();
    runner.dismissUndo();
  }

  // Each result moves focus to its status message, and a refusal to its reason.
  useEffect(() => {
    if (result !== null) statusRef.current?.focus();
  }, [result]);
  useEffect(() => {
    if (errorFocus > 0) errorRef.current?.focus();
  }, [errorFocus]);

  const show = (kind: ReminderResult): void => {
    results.current += 1;
    setResult({ kind, key: results.current });
  };
  const run = async (
    operation: Parameters<typeof runner.run>[0],
    done: ReminderResult,
  ): Promise<void> => {
    onCommand();
    // The status message below is the announcement, so the runner announces nothing. The last
    // result stays until this one replaces it, so the section never disappears mid-command.
    const succeeded = await runner.run(operation, '');
    if (succeeded) show(done);
    else {
      setResult(null);
      setErrorFocus((value) => value + 1);
    }
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const checked = checkReminder(date, time);
    setErrors(checked.errors);
    const input = checked.input;
    if (input === undefined) {
      (checked.errors.date === undefined ? timeRef : dateRef).current?.focus();
      return;
    }
    // Choosing the time the reminder already has saves nothing.
    if (
      reminder !== undefined &&
      reminder.date === input.date &&
      reminder.time.slice(0, 5) === input.time &&
      reminder.timeZone === profile.planningTimeZone
    ) {
      runner.clearError();
      show('unchanged');
      return;
    }
    await run(
      () =>
        reviews.setReviewReminder({
          reviewId: saved.reviewId,
          revision: saved.localRevision,
          ...(reminder === undefined ? {} : { reminderRevision: reminder.localRevision }),
          reminder: input,
        }),
      'saved',
    );
  };
  const turnOff = async (): Promise<void> => {
    if (busy || reminder === undefined) return;
    await run(
      () =>
        reviews.turnOffReviewReminder({
          reviewId: saved.reviewId,
          reminderRevision: reminder.localRevision,
        }),
      'off',
    );
  };
  const undo = async (): Promise<void> => {
    const undoId = runner.undoId;
    if (busy || undoId === null) return;
    await run(() => planning.undo(undoId), 'undone');
  };

  // A finished review without a reminder has nothing to show, unless a result is still showing.
  if (!open && reminder === undefined && result === null && runner.error === null) return null;

  const headingId = `${id}-heading`;
  const helpId = `${id}-help`;
  const zoneId = `${id}-zone`;
  const dateErrorId = `${id}-date-error`;
  const timeErrorId = `${id}-time-error`;
  const described = (error: string | undefined, errorId: string): string =>
    error === undefined ? zoneId : `${zoneId} ${errorId}`;
  const turnOffButton = reminder !== undefined && (
    <button type="button" aria-disabled={busy ? true : undefined} onClick={() => void turnOff()}>
      {uiMessage('review.review-reminder.1996')}
    </button>
  );

  return (
    <section className="review-section review-reminder" aria-labelledby={headingId}>
      <h2 id={headingId}>{uiMessage('plan.routine-form.1510')}</h2>
      {open && <p>{uiMessage('review.review-reminder.1997')}</p>}
      {reminder === undefined ? (
        !open && <p>{uiMessage('review.review-reminder.1998')}</p>
      ) : (
        <p>
          {uiMessage('review.review-reminder.1999', { value0: reminderWhen(reminder, profile) })}
        </p>
      )}
      {open ? (
        <form className="review-reminder-form" noValidate onSubmit={(event) => void save(event)}>
          <fieldset className="review-fieldset" aria-describedby={helpId}>
            <legend>{uiMessage('review.review-reminder.2000')}</legend>
            <p id={helpId} className="field-help">
              {reminderSavedCopy}
            </p>
            <div className="review-reminder-fields">
              <div className="review-reminder-field">
                <label htmlFor={`${id}-date`}>{uiMessage('plan.scheduling-dialogs.1663')}</label>
                <input
                  ref={dateRef}
                  id={`${id}-date`}
                  type="date"
                  required
                  value={date}
                  aria-invalid={errors.date === undefined ? undefined : true}
                  aria-describedby={described(errors.date, dateErrorId)}
                  onChange={(event) => setDate(event.target.value)}
                />
                {errors.date !== undefined && (
                  <p id={dateErrorId} className="review-reminder-error">
                    {errors.date}
                  </p>
                )}
              </div>
              <div className="review-reminder-field">
                <label htmlFor={`${id}-time`}>{uiMessage('plan.scheduling-dialogs.1664')}</label>
                <input
                  ref={timeRef}
                  id={`${id}-time`}
                  type="time"
                  required
                  value={time}
                  aria-invalid={errors.time === undefined ? undefined : true}
                  aria-describedby={described(errors.time, timeErrorId)}
                  onChange={(event) => setTime(event.target.value)}
                />
                {errors.time !== undefined && (
                  <p id={timeErrorId} className="review-reminder-error">
                    {errors.time}
                  </p>
                )}
              </div>
            </div>
            <p id={zoneId} className="field-help">
              {uiMessage('review.review-reminder.2001', {
                value0: profile.planningTimeZone.replace(/_/gu, ' '),
              })}
            </p>
          </fieldset>
          <div className="review-actions">
            <button
              type="submit"
              className="primary-button"
              aria-disabled={busy ? true : undefined}
            >
              {uiMessage('plan.routines.1601')}
            </button>
            {turnOffButton}
          </div>
        </form>
      ) : (
        <>
          {reminder !== undefined && <p>{uiMessage('review.review-reminder.2002')}</p>}
          <p className="field-help">{reminderSavedCopy}</p>
          {turnOffButton !== false && <div className="review-actions">{turnOffButton}</div>}
        </>
      )}
      {runner.error !== null && (
        <p ref={errorRef} className="validation-summary" role="alert" tabIndex={-1}>
          {runner.error}
        </p>
      )}
      <div role="status">
        {result !== null && (
          <p key={result.key} ref={statusRef} className="review-summary" tabIndex={-1}>
            {resultText[result.kind]}
          </p>
        )}
      </div>
      {result !== null &&
        (result.kind === 'saved' || result.kind === 'off') &&
        runner.undoId !== null && (
          <div className="review-actions">
            <button
              type="button"
              aria-disabled={busy ? true : undefined}
              onClick={() => void undo()}
            >
              {uiMessage('actions-ui.236')}
            </button>
          </div>
        )}
    </section>
  );
}
