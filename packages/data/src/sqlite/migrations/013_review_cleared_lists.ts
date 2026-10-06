import { defineMigration } from './migration';

/**
 * Review cleared review lists. A saved review remembers which of its ordered lists the
 * person emptied on purpose: End Day's next-day focus, or the weekly review's commitments and
 * first-day focus. Without it, an emptied list was stored like an omitted one, so a resumed draft
 * showed the plan's current list again and a later Finish left that list unchanged.
 *
 * One nullable column holding the versionless JSON array of list keys; NULL means no list was
 * cleared. SQL checks only that the text is valid JSON: which keys a review type may hold, and that
 * they are unique, sorted, and non-empty, are record-codec rules, like every other review field.
 * Existing rows keep every value and read as clearing nothing, so the upgrade rewrites no row.
 */
export const reviewClearedListsMigration = defineMigration(
  13,
  'review_cleared_lists',
  `
    ALTER TABLE review_checkpoints ADD COLUMN cleared_lists_json TEXT
      CHECK (cleared_lists_json IS NULL OR json_valid(cleared_lists_json));
  `,
);
