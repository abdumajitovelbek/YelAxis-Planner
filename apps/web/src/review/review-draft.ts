/**
 * Review drafts in the browser: turning a saved review's items back into the choices a
 * form shows when it is resumed, and comparing choices so a form knows what is unsaved and what
 * changed from the plan. Pure presentation helpers: SQLite keeps the canonical draft.
 */
import type {
  FocusChoices,
  FocusTargetInput,
  OccurrenceTargetInput,
  ReviewListKey,
  SavedReview,
  SavedReviewItem,
} from '@yelaxis/application';
import { occurrencePeriodKey, reviewDecisionSlot } from '@yelaxis/domain';

import {
  focusCandidateTitle,
  focusItemTitle,
  sameFocusTarget,
  type FocusDraftItem,
} from '../today/choose-focus-dialog';

/** Saved items in the person's order within their slot. */
export const byPosition = (left: SavedReviewItem, right: SavedReviewItem): number =>
  left.position - right.position;

export interface SavedItemsBySlot {
  /** State decisions (continue, pause, complete, carry, move, …). */
  readonly state: readonly SavedReviewItem[];
  readonly focus: readonly SavedReviewItem[];
  readonly commit: readonly SavedReviewItem[];
  readonly note: readonly SavedReviewItem[];
}

/** A saved review's items by decision slot; focus and commitments in the person's order. */
export function itemsBySlot(items: readonly SavedReviewItem[]): SavedItemsBySlot {
  const slot = (name: 'state' | 'focus' | 'commit' | 'note'): SavedReviewItem[] =>
    items.filter((item) => reviewDecisionSlot(item.decision) === name);
  return {
    state: slot('state'),
    focus: slot('focus').sort(byPosition),
    commit: slot('commit').sort(byPosition),
    note: slot('note'),
  };
}

/** Whether two occurrence inputs name the same Routine Occurrence (Routine, generation, period). */
export function sameOccurrence(left: OccurrenceTargetInput, right: OccurrenceTargetInput): boolean {
  return (
    left.routineId.toLowerCase() === right.routineId.toLowerCase() &&
    left.generation === right.generation &&
    occurrencePeriodKey(left.period) === occurrencePeriodKey(right.period)
  );
}

/**
 * A saved focus choice as a focus draft item. It takes the key of the same target among the date's
 * focus or candidates, so the draft editor shows it chosen; null for a target that cannot be focus
 * (for example a deleted object).
 */
export function focusDraftFromItem(
  item: SavedReviewItem,
  choices: FocusChoices,
): FocusDraftItem | null {
  const target = item.target;
  let input: FocusTargetInput;
  let label: string;
  if (target.kind === 'action') {
    input = { kind: 'action', actionId: target.id };
    label = target.title;
  } else if (target.kind === 'routine_occurrence') {
    input = { kind: 'routine_occurrence', occurrence: target.occurrence };
    label = target.routineTitle;
  } else return null;
  const known = [
    ...choices.current.map((entry) => ({
      key: entry.key,
      target: entry.target,
      label: focusItemTitle(entry),
    })),
    ...choices.candidates.map((entry) => ({
      key: entry.key,
      target: entry.target,
      label: focusCandidateTitle(entry),
    })),
  ].find((entry) => sameFocusTarget(entry.target, input));
  if (known !== undefined) return { key: known.key, label: known.label, target: known.target };
  const key =
    input.kind === 'action'
      ? `action:${input.actionId}`
      : `routine_occurrence:${input.occurrence.routineId}:${String(
          input.occurrence.generation,
        )}:${occurrencePeriodKey(input.occurrence.period)}`;
  return { key, label, target: input };
}

/** Whether the saved review emptied this list on purpose. */
export function isClearedList(
  saved: Pick<SavedReview, 'clearedLists'> | null,
  list: ReviewListKey,
): boolean {
  return saved?.clearedLists?.includes(list) === true;
}

/**
 * The saved focus choices as a draft, in order. A resumed list starts from its saved items if any,
 * else from no items when the review cleared it, else (null) from the plan's current focus.
 */
export function focusDraftFromSaved(
  saved: Pick<SavedReview, 'items' | 'clearedLists'> | null,
  list: Extract<ReviewListKey, 'next_focus' | 'first_day_focus'>,
  choices: FocusChoices,
): readonly FocusDraftItem[] | null {
  const focus = itemsBySlot(saved?.items ?? []).focus;
  if (focus.length === 0) return isClearedList(saved, list) ? [] : null;
  return focus.flatMap((item) => {
    const draft = focusDraftFromItem(item, choices);
    return draft === null ? [] : [draft];
  });
}

/** Same keys in the same order. */
export function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/** Text with something other than white space in it. */
export const hasText = (value: string): boolean => value.trim().length > 0;

/*
 * A form is unsaved exactly when Save for later would store something else, so these compare
 * choices as a saved review keeps them. Then Save always clears the unsaved state, and leaving
 * never asks to save what a Save cannot keep.
 */

/** Optional text as a saved review keeps it: blank text is not kept. */
export const storedText = (value: string): string => (hasText(value) ? value : '');

/**
 * An ordered choice (focus or commitments) as a saved review keeps it. A choice equal to the plan's
 * is not sent, so it reads back as the plan's own list (null). Any other choice is kept as it is:
 * its items, or, for an empty choice, the cleared list (`SavedReview.clearedLists`).
 */
export function storedKeys(
  keys: readonly string[],
  plan: readonly string[],
): readonly string[] | null {
  return sameKeys(keys, plan) ? null : keys;
}

/** Two ordered choices a saved review keeps the same way (see `storedKeys`). */
export function sameStoredKeys(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  return left === null || right === null ? left === right : sameKeys(left, right);
}
