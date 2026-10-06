import { createContext, useContext } from 'react';

/** Milliseconds since the epoch, like `Date.now`. */
export type NowSource = () => number;

/**
 * The clock Today, Focus mode, and End Day read for the live date, the current-time marker, and
 * the optional timer. The browser clock by default; tests provide a controllable one.
 */
export const ClockContext = createContext<NowSource>(() => Date.now());

/** The injected clock (the browser clock unless a test provides one). */
export function useClock(): NowSource {
  return useContext(ClockContext);
}
