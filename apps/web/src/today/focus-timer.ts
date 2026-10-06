import { message as uiMessage } from '../messages';
/**
 * The optional Focus mode timer. Presentation state only: it lives in React memory
 * for one Focus mode page, is never stored, sent, or recorded, and never changes the plan. The
 * reducer is pure and works from timestamps, so a background tab (whose timers the browser slows
 * or stops) still reads correctly when it is shown again. There is no sound, notification, wake
 * lock, or fullscreen.
 */
import { useEffect, useRef, useState } from 'react';

import type { NowSource } from './clock-context';

const minuteMs = 60_000;

/** "Add 5 minutes". */
export const timerExtensionMs = 5 * minuteMs;

/** The custom length a person can type, in whole minutes. */
export const customTimerMinutes = Object.freeze({ min: 1, max: 240 });

/** What the last button press did, so the status line can say it once. */
export type TimerEvent = 'started' | 'paused' | 'resumed' | 'reset' | 'extended';

export type TimerState =
  | { readonly status: 'idle'; readonly last: 'reset' | null }
  | {
      readonly status: 'running';
      /** The length, or null for "No time limit" (the timer counts up). */
      readonly limitMs: number | null;
      /** When the current running stretch began. */
      readonly startedAt: number;
      /** Time counted before the current running stretch (earlier stretches). */
      readonly elapsedBeforeMs: number;
      readonly last: TimerEvent;
    }
  | {
      readonly status: 'paused';
      readonly limitMs: number | null;
      readonly elapsedMs: number;
      readonly last: TimerEvent;
    };

export type TimerAction =
  | { readonly type: 'start'; readonly at: number; readonly limitMs: number | null }
  | { readonly type: 'pause'; readonly at: number }
  | { readonly type: 'resume'; readonly at: number }
  | { readonly type: 'reset'; readonly at: number }
  | { readonly type: 'extend'; readonly at: number };

export const initialTimerState: TimerState = Object.freeze({ status: 'idle', last: null });

/** Counted time; a clock that moved backwards never makes it negative. */
export function timerElapsedMs(state: TimerState, now: number): number {
  switch (state.status) {
    case 'idle':
      return 0;
    case 'paused':
      return state.elapsedMs;
    case 'running':
      return state.elapsedBeforeMs + Math.max(0, now - state.startedAt);
  }
}

const validLimit = (limitMs: number | null): boolean =>
  limitMs === null || (Number.isFinite(limitMs) && limitMs > 0);

/**
 * Pure timer transitions. A press that does not apply to the current state (Pause while paused,
 * Add 5 minutes without a length) leaves the state unchanged.
 */
export function timerReducer(state: TimerState, action: TimerAction): TimerState {
  switch (action.type) {
    case 'start':
      if (state.status !== 'idle' || !validLimit(action.limitMs)) return state;
      return {
        status: 'running',
        limitMs: action.limitMs,
        startedAt: action.at,
        elapsedBeforeMs: 0,
        last: 'started',
      };
    case 'pause':
      if (state.status !== 'running') return state;
      return {
        status: 'paused',
        limitMs: state.limitMs,
        elapsedMs: timerElapsedMs(state, action.at),
        last: 'paused',
      };
    case 'resume':
      if (state.status !== 'paused') return state;
      return {
        status: 'running',
        limitMs: state.limitMs,
        startedAt: action.at,
        elapsedBeforeMs: state.elapsedMs,
        last: 'resumed',
      };
    case 'reset':
      return state.status === 'idle' ? state : { status: 'idle', last: 'reset' };
    case 'extend': {
      if (state.status === 'idle' || state.limitMs === null) return state;
      // Once time is up the reading is 00:00, so the five minutes count from the press: a press
      // long after time was up still gives five more minutes instead of changing nothing.
      const counted = Math.max(state.limitMs, timerElapsedMs(state, action.at));
      return { ...state, limitMs: counted + timerExtensionMs, last: 'extended' };
    }
  }
}

export interface TimerReading {
  readonly elapsedMs: number;
  /** Null when the timer counts up ("No time limit"). */
  readonly remainingMs: number | null;
  /** The chosen length has passed while running or paused. */
  readonly timeUp: boolean;
  /** "mm:ss remaining" or "mm:ss elapsed". */
  readonly text: string;
}

/** Minutes may exceed 59 ("75:00"); seconds are always two digits. */
export function formatTimerClock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * What the timer shows at `now`. While idle it shows the chosen length (`idleLimitMs`). Remaining
 * time rounds up to the whole second, so a new 25-minute timer reads 25:00 until a second passes.
 */
export function timerReading(
  state: TimerState,
  now: number,
  idleLimitMs: number | null = null,
): TimerReading {
  const elapsedMs = timerElapsedMs(state, now);
  const limitMs = state.status === 'idle' ? idleLimitMs : state.limitMs;
  if (limitMs === null)
    return {
      elapsedMs,
      remainingMs: null,
      timeUp: false,
      text: uiMessage('release.labels.44', {
        value0: formatTimerClock(Math.floor(elapsedMs / 1000) * 1000),
      }),
    };
  const remainingMs = Math.max(0, limitMs - elapsedMs);
  return {
    elapsedMs,
    remainingMs,
    timeUp: state.status !== 'idle' && remainingMs === 0,
    text: uiMessage('release.labels.45', {
      value0: formatTimerClock(Math.ceil(remainingMs / 1000) * 1000),
    }),
  };
}

export const timeUpMessage = uiMessage('release.labels.46');

/**
 * The status line, said once per change by a polite live region: the last press, or time up while
 * running. Idle before any press says nothing.
 */
export function timerStatusText(state: TimerState, reading: TimerReading): string {
  if (state.status === 'running' && reading.timeUp) return timeUpMessage;
  switch (state.last) {
    case null:
      return '';
    case 'started':
      return uiMessage('release.labels.47');
    case 'paused':
      return uiMessage('release.labels.48');
    case 'resumed':
      return uiMessage('release.labels.49');
    case 'reset':
      return uiMessage('release.labels.50');
    case 'extended':
      return '5 minutes added.';
  }
}

/** Milliseconds until the timer's next whole second, counted from its own start. */
export function nextTimerTickDelay(state: TimerState, now: number): number {
  const elapsed = timerElapsedMs(state, now);
  return 1000 - (elapsed % 1000) + 5;
}

/**
 * The time a running timer is drawn at: re-read once per timer second while the page is visible.
 * Nothing ticks while the page is hidden; showing it again (visibility, `pageshow`, or window focus)
 * re-reads the clock at once, so the reading is correct without catching up.
 */
export function useTimerNow(state: TimerState, now: NowSource): number {
  const [drawnAt, setDrawnAt] = useState(now);
  const clock = useRef(now);
  clock.current = now;
  const running = state.status === 'running';
  useEffect(() => {
    const now = (): number => clock.current();
    if (!running) {
      setDrawnAt(now());
      return;
    }
    let timeout: number | undefined;
    const draw = (): void => {
      window.clearTimeout(timeout);
      timeout = undefined;
      if (document.visibilityState === 'hidden') return;
      const current = now();
      setDrawnAt(current);
      timeout = window.setTimeout(draw, nextTimerTickDelay(state, current));
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        window.clearTimeout(timeout);
        timeout = undefined;
      } else draw();
    };
    draw();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', draw);
    window.addEventListener('focus', draw);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', draw);
      window.removeEventListener('focus', draw);
    };
  }, [running, state]);
  return drawnAt;
}

/** Whole minutes from a typed custom length, or null when outside 1–240. */
export function parseCustomMinutes(value: string): number | null {
  const text = value.trim();
  if (!/^\d+$/u.test(text)) return null;
  const minutes = Number(text);
  return minutes >= customTimerMinutes.min && minutes <= customTimerMinutes.max ? minutes : null;
}

/** Minutes to milliseconds. */
export const minutesMs = (minutes: number): number => minutes * minuteMs;
