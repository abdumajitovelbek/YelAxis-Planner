// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IanaTimeZone } from '@yelaxis/domain';

import { isClockJump, nextMinuteDelay, readLiveNow, useLiveNow } from './live-clock';

const newYork = 'America/New_York' as IanaTimeZone;
const ms = (value: string): number => Date.parse(value);

describe('live clock helpers', () => {
  it('waits until just after the next minute boundary', () => {
    expect(nextMinuteDelay(ms('2026-09-28T13:00:00.000Z'))).toBe(60_025);
    expect(nextMinuteDelay(ms('2026-09-28T13:00:59.000Z'))).toBe(1_025);
    expect(nextMinuteDelay(ms('2026-09-28T13:00:30.500Z'))).toBe(29_525);
  });

  it('treats more than 90 seconds off the expected reading as a clock change', () => {
    const expected = ms('2026-09-28T13:01:00.025Z');
    expect(isClockJump(expected, expected + 90_000)).toBe(false);
    expect(isClockJump(expected, expected - 90_000)).toBe(false);
    expect(isClockJump(expected, expected + 90_001)).toBe(true);
    expect(isClockJump(expected, expected - 3_600_000)).toBe(true);
  });

  it('reads now in the planning zone, not the device zone', () => {
    expect(readLiveNow(ms('2026-09-29T03:30:00.000Z'), newYork)).toEqual({
      epochMs: ms('2026-09-29T03:30:00.000Z'),
      instant: '2026-09-29T03:30:00.000Z',
      date: '2026-09-28',
      wallTime: '23:30',
      minuteOfDay: 23 * 60 + 30,
    });
    expect(
      readLiveNow(ms('2026-09-29T03:30:00.000Z'), 'Asia/Tashkent' as IanaTimeZone),
    ).toMatchObject({ date: '2026-09-29', wallTime: '08:30' });
  });

  it('repeats an hour at a fall-back and skips one at a spring-forward', () => {
    // 2026-11-01 in New York: 01:30 happens twice.
    expect(readLiveNow(ms('2026-11-01T05:30:00.000Z'), newYork).minuteOfDay).toBe(90);
    expect(readLiveNow(ms('2026-11-01T06:30:00.000Z'), newYork).minuteOfDay).toBe(90);
    // 2026-03-08: 01:59 is followed by 03:00.
    expect(readLiveNow(ms('2026-03-08T06:59:00.000Z'), newYork).minuteOfDay).toBe(119);
    expect(readLiveNow(ms('2026-03-08T07:00:00.000Z'), newYork).minuteOfDay).toBe(180);
  });
});

let renders = 0;
function Probe({ zone }: { readonly zone: IanaTimeZone }): ReactNode {
  const live = useLiveNow(zone);
  renders += 1;
  return <p data-testid="now">{`${live.date} ${live.wallTime}`}</p>;
}

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  renders = 0;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const shown = () => screen.getByTestId('now').textContent;
const setVisibility = (next: DocumentVisibilityState): void => {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

describe('useLiveNow', () => {
  it('moves on at each minute boundary and across midnight', () => {
    vi.setSystemTime(ms('2026-09-29T03:58:30.000Z'));
    render(<Probe zone={newYork} />);
    expect(shown()).toBe('2026-09-28 23:58');
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(shown()).toBe('2026-09-28 23:58');
    act(() => {
      vi.advanceTimersByTime(1_100);
    });
    expect(shown()).toBe('2026-09-28 23:59');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(shown()).toBe('2026-09-29 00:00');
  });

  it('re-renders only when the minute changes', () => {
    vi.setSystemTime(ms('2026-09-28T13:00:10.000Z'));
    render(<Probe zone={newYork} />);
    const before = renders;
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(renders).toBe(before);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('keeps no timer while hidden and refreshes on return', () => {
    vi.setSystemTime(ms('2026-09-28T13:00:10.000Z'));
    render(<Probe zone={newYork} />);
    expect(vi.getTimerCount()).toBe(1);
    setVisibility('hidden');
    expect(vi.getTimerCount()).toBe(0);
    // Eight hours pass in the background: nothing ticks.
    vi.setSystemTime(ms('2026-09-28T21:00:10.000Z'));
    expect(shown()).toBe('2026-09-28 09:00');
    setVisibility('visible');
    expect(shown()).toBe('2026-09-28 17:00');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('shows a clock change at once on focus or pageshow', () => {
    vi.setSystemTime(ms('2026-09-28T13:00:10.000Z'));
    render(<Probe zone={newYork} />);
    vi.setSystemTime(ms('2026-09-30T12:00:00.000Z'));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(shown()).toBe('2026-09-30 08:00');
    vi.setSystemTime(ms('2026-10-01T12:00:00.000Z'));
    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(shown()).toBe('2026-10-01 08:00');
  });

  it('shows a clock change when the next tick fires far from its boundary', () => {
    vi.setSystemTime(ms('2026-09-28T13:00:10.000Z'));
    render(<Probe zone={newYork} />);
    // The system clock is set back two hours without any event.
    vi.setSystemTime(ms('2026-09-28T11:00:10.000Z'));
    act(() => {
      vi.advanceTimersByTime(50_100);
    });
    expect(shown()).toBe('2026-09-28 07:01');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('follows a change of planning zone', () => {
    vi.setSystemTime(ms('2026-09-29T03:30:00.000Z'));
    const view = render(<Probe zone={newYork} />);
    expect(shown()).toBe('2026-09-28 23:30');
    view.rerender(<Probe zone={'Asia/Tashkent' as IanaTimeZone} />);
    expect(shown()).toBe('2026-09-29 08:30');
  });

  it('clears its timer and listeners on unmount', () => {
    vi.setSystemTime(ms('2026-09-28T13:00:10.000Z'));
    const view = render(<Probe zone={newYork} />);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
