/**
 * The live planning clock for Today. It reads the injected clock in the Profile
 * planning zone and refreshes at each minute boundary, when the page becomes visible again
 * (`visibilitychange`, `pageshow`, `focus`), and at once after a clock change. No timer runs while
 * the page is hidden. Presentation only: nothing is stored or sent.
 */
import { useEffect, useMemo, useState } from 'react';

import {
  formatInstantInZone,
  type CalendarDate,
  type IanaTimeZone,
  type Instant,
  type WallTime,
} from '@yelaxis/domain';

import { useClock } from './clock-context';

export const minuteMs = 60_000;
/** A reading further than this from the expected one means the clock changed (or the device slept). */
export const clockJumpMs = 90_000;
/** Fire just after the boundary so the new minute is always the one read. */
const boundarySlackMs = 25;

/** Milliseconds until just after the next minute boundary. */
export function nextMinuteDelay(epochMs: number): number {
  const into = ((epochMs % minuteMs) + minuteMs) % minuteMs;
  return minuteMs - into + boundarySlackMs;
}

/** True when the clock moved more than 90 seconds away from the expected reading. */
export function isClockJump(expectedMs: number, actualMs: number): boolean {
  return Math.abs(actualMs - expectedMs) > clockJumpMs;
}

export interface LiveNow {
  readonly epochMs: number;
  readonly instant: Instant;
  /** Planning today: the date of now in the planning zone. */
  readonly date: CalendarDate;
  /** Wall-clock time of now in the planning zone (minutes precision). */
  readonly wallTime: WallTime;
  /** Minutes after local midnight of `wallTime` (repeats at a fall-back, jumps at a spring-forward). */
  readonly minuteOfDay: number;
}

export function readLiveNow(epochMs: number, zone: IanaTimeZone): LiveNow {
  const instant = new Date(epochMs).toISOString() as Instant;
  const zoned = formatInstantInZone(instant, zone);
  const [hours = '0', minutes = '0'] = zoned.time.split(':');
  return {
    epochMs,
    instant,
    date: zoned.date,
    wallTime: zoned.time,
    minuteOfDay: Number(hours) * 60 + Number(minutes),
  };
}

const sameMinute = (left: number, right: number): boolean =>
  Math.floor(left / minuteMs) === Math.floor(right / minuteMs);

/**
 * Now in the planning zone, refreshed at each minute boundary while the page is visible, on
 * return to the page, and after a clock change. Re-renders only when the minute changes.
 */
export function useLiveNow(zone: IanaTimeZone): LiveNow {
  const clock = useClock();
  const [reading, setReading] = useState(() => clock());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expected: number | null = null;
    const stop = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      expected = null;
    };
    const show = (now: number, force: boolean): void =>
      setReading((previous) => (force || !sameMinute(previous, now) ? now : previous));
    const arm = (now: number): void => {
      stop();
      // nothing ticks while the page is hidden.
      if (document.visibilityState === 'hidden') return;
      const delay = nextMinuteDelay(now);
      expected = now + delay;
      timer = setTimeout(tick, delay);
    };
    function tick(): void {
      const now = clock();
      // A late or early firing far from the boundary means the clock changed: show it now.
      show(now, expected !== null && isClockJump(expected, now));
      arm(now);
    }
    const refresh = (): void => {
      const now = clock();
      show(now, false);
      arm(now);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') stop();
      else refresh();
    };
    refresh();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [clock]);
  return useMemo(() => readLiveNow(reading, zone), [reading, zone]);
}
