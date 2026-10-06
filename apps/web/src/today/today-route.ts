/**
 * Today's route and date. `/` is the live planning today; `/?date=YYYY-MM-DD` is a
 * selected date that only in-app navigation creates and that never rolls over. A fresh document
 * entry (a new tab, a typed or launched URL, or a reload) always opens the live today, so its
 * `?date` is dropped; Back/Forward (in-app, or a `back_forward` document load) keeps it.
 */
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { parseCalendarDate, type CalendarDate } from '@yelaxis/domain';

/** How the browser loaded this document (`PerformanceNavigationTiming.type`). */
export type DocumentNavigationType = 'navigate' | 'reload' | 'back_forward' | 'prerender';

/** The URL the document was loaded with and how it was loaded. */
export interface TodayDocumentEntry {
  /** `pathname + search` of the document's initial URL. */
  readonly initialUrl: string;
  readonly initialType: DocumentNavigationType;
}

const documentTypes: readonly DocumentNavigationType[] = [
  'navigate',
  'reload',
  'back_forward',
  'prerender',
];
const freshTypes: readonly DocumentNavigationType[] = ['navigate', 'reload', 'prerender'];

/**
 * A fresh Today entry is the first Today render of the document's initial URL when the document
 * was navigated to, reloaded, or prerendered (never a Back/Forward load). Pure.
 */
export function isFreshTodayEntry(input: {
  readonly initialUrl: string;
  readonly initialType: DocumentNavigationType;
  readonly currentUrl: string;
  /** The document's first Today render has already happened. */
  readonly consumed: boolean;
}): boolean {
  return (
    !input.consumed &&
    input.currentUrl === input.initialUrl &&
    freshTypes.includes(input.initialType)
  );
}

/** Read how this document was loaded; an unknown or missing entry counts as a navigation. */
export function readDocumentEntry(): TodayDocumentEntry {
  let initialType: DocumentNavigationType = 'navigate';
  try {
    const entry: unknown = performance.getEntriesByType('navigation')[0];
    const type =
      typeof entry === 'object' && entry !== null && 'type' in entry ? entry.type : undefined;
    const known = documentTypes.find((candidate) => candidate === type);
    if (known !== undefined) initialType = known;
  } catch {
    // Older engines without navigation timing: treat the load as a navigation.
  }
  return { initialUrl: `${window.location.pathname}${window.location.search}`, initialType };
}

/** Answers, once per document, whether a Today render is the fresh entry. */
export interface TodayEntryTracker {
  /**
   * True only for the document's first Today render when it is fresh. Stable for that history
   * entry (`key` and URL), so repeated renders of it agree; every later entry is false.
   */
  isFresh(currentUrl: string, key: string): boolean;
}

export function createTodayEntryTracker(entry: TodayDocumentEntry): TodayEntryTracker {
  let first: { readonly key: string; readonly url: string; readonly fresh: boolean } | null = null;
  return {
    isFresh(currentUrl, key) {
      first ??= {
        key,
        url: currentUrl,
        fresh: isFreshTodayEntry({ ...entry, currentUrl, consumed: false }),
      };
      return first.fresh && first.key === key && first.url === currentUrl;
    },
  };
}

/** Captured when the application loads, before any in-app navigation. */
const documentTodayEntry = createTodayEntryTracker(readDocumentEntry());

export type TodayMode =
  | { readonly kind: 'live' }
  /** A date chosen in the app; it never rolls over. */
  | { readonly kind: 'selected'; readonly date: CalendarDate }
  /** `?date` is present but is not a real calendar date. */
  | { readonly kind: 'invalid' };

const liveMode: TodayMode = Object.freeze({ kind: 'live' });

/** Read Today's search: no `date` is live today, a real date is selected, anything else invalid. */
export function parseTodaySearch(search: string): TodayMode {
  const value = new URLSearchParams(search).get('date');
  if (value === null) return liveMode;
  const date = parseCalendarDate(value);
  return date.ok ? { kind: 'selected', date: date.value } : { kind: 'invalid' };
}

/**
 * Today's mode for the current location. On the document's fresh entry a `?date` (valid or not)
 * is dropped with a replace, so a reload or a new tab always opens the live today.
 */
export function useTodayMode(tracker: TodayEntryTracker = documentTodayEntry): TodayMode {
  const location = useLocation();
  const navigate = useNavigate();
  const fresh = tracker.isFresh(`${location.pathname}${location.search}`, location.key);
  const parsed = parseTodaySearch(location.search);
  const drop = fresh && parsed.kind !== 'live';
  useEffect(() => {
    if (drop) void navigate('/', { replace: true });
  }, [drop, navigate]);
  return drop ? liveMode : parsed;
}
