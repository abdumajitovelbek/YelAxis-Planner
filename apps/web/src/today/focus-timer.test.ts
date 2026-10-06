import { describe, expect, it } from 'vitest';

import {
  formatTimerClock,
  initialTimerState,
  minutesMs,
  nextTimerTickDelay,
  parseCustomMinutes,
  timeUpMessage,
  timerElapsedMs,
  timerReading,
  timerReducer,
  timerStatusText,
  type TimerAction,
  type TimerState,
} from './focus-timer';

const start = Date.parse('2026-09-28T09:00:00.000Z');
const minute = 60_000;

const run = (actions: readonly TimerAction[], state: TimerState = initialTimerState): TimerState =>
  actions.reduce(timerReducer, state);

describe('timerReducer', () => {
  it('starts, pauses, resumes, and resets from timestamps only', () => {
    const started = run([{ type: 'start', at: start, limitMs: minutesMs(25) }]);
    expect(started).toEqual({
      status: 'running',
      limitMs: minutesMs(25),
      startedAt: start,
      elapsedBeforeMs: 0,
      last: 'started',
    });
    const paused = timerReducer(started, { type: 'pause', at: start + 10 * minute });
    expect(paused).toEqual({
      status: 'paused',
      limitMs: minutesMs(25),
      elapsedMs: 10 * minute,
      last: 'paused',
    });
    // Time passing while paused changes nothing.
    expect(timerReading(paused, start + 60 * minute).text).toBe('15:00 remaining');
    const resumed = timerReducer(paused, { type: 'resume', at: start + 60 * minute });
    expect(timerReading(resumed, start + 65 * minute).text).toBe('10:00 remaining');
    expect(timerReducer(resumed, { type: 'reset', at: start })).toEqual({
      status: 'idle',
      last: 'reset',
    });
  });

  it('ignores presses that do not apply', () => {
    const started = run([{ type: 'start', at: start, limitMs: null }]);
    expect(timerReducer(started, { type: 'start', at: start + 1, limitMs: 5 })).toBe(started);
    expect(timerReducer(started, { type: 'resume', at: start + 1 })).toBe(started);
    expect(timerReducer(started, { type: 'extend', at: start + 1 })).toBe(started);
    expect(timerReducer(initialTimerState, { type: 'pause', at: start })).toBe(initialTimerState);
    expect(timerReducer(initialTimerState, { type: 'reset', at: start })).toBe(initialTimerState);
    expect(timerReducer(initialTimerState, { type: 'start', at: start, limitMs: 0 })).toBe(
      initialTimerState,
    );
    expect(timerReducer(initialTimerState, { type: 'start', at: start, limitMs: Number.NaN })).toBe(
      initialTimerState,
    );
  });

  it('adds five minutes to the remaining time', () => {
    const started = run([{ type: 'start', at: start, limitMs: minutesMs(15) }]);
    const extended = timerReducer(started, { type: 'extend', at: start + 10 * minute });
    expect(extended.status === 'running' && extended.limitMs).toBe(minutesMs(20));
    const reading = timerReading(extended, start + 10 * minute);
    expect(reading).toMatchObject({ timeUp: false, text: '10:00 remaining' });
    expect(timerStatusText(extended, reading)).toBe('5 minutes added.');
  });

  it('gives five more minutes from the press once time is up, however long ago', () => {
    const started = run([{ type: 'start', at: start, limitMs: minutesMs(15) }]);
    for (const overrun of [1, 5, 25]) {
      const at = start + (15 + overrun) * minute;
      expect(timerReading(started, at).timeUp).toBe(true);
      const extended = timerReducer(started, { type: 'extend', at });
      const reading = timerReading(extended, at);
      expect(reading).toMatchObject({ timeUp: false, text: '05:00 remaining' });
      expect(timerStatusText(extended, reading)).toBe('5 minutes added.');
    }
    // A paused timer past its length gets five minutes from where it stopped.
    const paused = timerReducer(started, { type: 'pause', at: start + 40 * minute });
    const extended = timerReducer(paused, { type: 'extend', at: start + 90 * minute });
    expect(timerReading(extended, start + 90 * minute).text).toBe('05:00 remaining');
  });
});

describe('timerReading', () => {
  it('stays correct after a long background gap and never counts a clock moved back', () => {
    const started = run([{ type: 'start', at: start, limitMs: minutesMs(25) }]);
    expect(timerReading(started, start).text).toBe('25:00 remaining');
    expect(timerReading(started, start + 1).text).toBe('25:00 remaining');
    expect(timerReading(started, start + 1000).text).toBe('24:59 remaining');
    // Hours in a hidden tab: the reading comes from timestamps, not from counted ticks.
    expect(timerReading(started, start + 3 * 60 * minute)).toMatchObject({
      remainingMs: 0,
      timeUp: true,
      text: '00:00 remaining',
    });
    expect(timerElapsedMs(started, start - 5 * minute)).toBe(0);
  });

  it('counts up without a limit and shows the chosen length while idle', () => {
    const counting = run([{ type: 'start', at: start, limitMs: null }]);
    expect(timerReading(counting, start + 75 * minute + 12_400)).toMatchObject({
      remainingMs: null,
      timeUp: false,
      text: '75:12 elapsed',
    });
    expect(timerReading(initialTimerState, start, minutesMs(50)).text).toBe('50:00 remaining');
    expect(timerReading(initialTimerState, start, null).text).toBe('00:00 elapsed');
    expect(timerReading(initialTimerState, start, minutesMs(1)).timeUp).toBe(false);
  });
});

describe('timerStatusText', () => {
  it('says each change once, and time up while running', () => {
    const say = (state: TimerState, now = start) =>
      timerStatusText(state, timerReading(state, now));
    expect(say(initialTimerState)).toBe('');
    const started = run([{ type: 'start', at: start, limitMs: minutesMs(15) }]);
    expect(say(started)).toBe('Timer started.');
    expect(say(started, start + 15 * minute)).toBe(timeUpMessage);
    expect(timeUpMessage).toBe('Time is up. Continue, pause, or complete when you are ready.');
    const paused = timerReducer(started, { type: 'pause', at: start + minute });
    expect(say(paused)).toBe('Timer paused.');
    expect(say(timerReducer(paused, { type: 'resume', at: start + 2 * minute }))).toBe(
      'Timer resumed.',
    );
    expect(say(timerReducer(paused, { type: 'reset', at: start }))).toBe('Timer reset.');
  });
});

describe('helpers', () => {
  it('formats minutes and seconds with two digits', () => {
    expect(formatTimerClock(0)).toBe('00:00');
    expect(formatTimerClock(59_000)).toBe('00:59');
    expect(formatTimerClock(240 * minute)).toBe('240:00');
  });

  it('reads a custom length of 1 to 240 whole minutes', () => {
    expect(parseCustomMinutes('1')).toBe(1);
    expect(parseCustomMinutes(' 240 ')).toBe(240);
    for (const value of ['', '0', '241', '2.5', '-5', 'ten', '1e2'])
      expect(parseCustomMinutes(value)).toBeNull();
  });

  it('waits until the timer’s next whole second', () => {
    const started = run([{ type: 'start', at: start, limitMs: minutesMs(25) }]);
    expect(nextTimerTickDelay(started, start + 250)).toBe(755);
    expect(nextTimerTickDelay(started, start)).toBe(1005);
  });
});
