import { describe, expect, it } from 'vitest';

import type { PlanProfile } from '@yelaxis/application';
import type { IanaTimeZone } from '@yelaxis/domain';

import { readLiveNow } from './live-clock';
import { nowLabel, nowMarker, showsEarlyHours } from './now-marker';

const newYork = 'America/New_York' as IanaTimeZone;
const profile: Pick<PlanProfile, 'planningTimeZone' | 'timeFormat'> = {
  planningTimeZone: newYork,
  timeFormat: '12_hour',
};
const live = (instant: string) => readLiveNow(Date.parse(instant), newYork);

describe('nowMarker', () => {
  it('sits at the minute of now on the live planning today', () => {
    expect(nowMarker(live('2026-09-28T13:05:00.000Z'), '2026-09-28', profile, newYork)).toEqual({
      minute: 9 * 60 + 5,
      label: 'Now 9:05 AM',
    });
  });

  it('is hidden on every other date', () => {
    const now = live('2026-09-28T13:05:00.000Z');
    for (const date of ['2026-09-27', '2026-09-29'])
      expect(nowMarker(now, date, profile, newYork)).toBeUndefined();
  });

  it('uses the planning date, which can differ from the UTC date', () => {
    const lateEvening = live('2026-09-29T03:30:00.000Z');
    expect(nowMarker(lateEvening, '2026-09-29', profile, newYork)).toBeUndefined();
    expect(nowMarker(lateEvening, '2026-09-28', profile, newYork)?.minute).toBe(23 * 60 + 30);
  });

  it('names the planning zone only when the device is in another zone', () => {
    const now = live('2026-09-28T13:05:00.000Z');
    expect(nowLabel(now, profile, newYork)).toBe('Now 9:05 AM');
    expect(nowLabel(now, profile, undefined)).toBe('Now 9:05 AM');
    expect(nowLabel(now, profile, 'Asia/Tashkent')).toBe('Now 9:05 AM in America/New_York');
    expect(nowLabel(now, { ...profile, timeFormat: '24_hour' }, newYork)).toBe('Now 09:05');
  });

  it('shows early hours before 06:00 only', () => {
    expect(showsEarlyHours(0)).toBe(true);
    expect(showsEarlyHours(359)).toBe(true);
    expect(showsEarlyHours(360)).toBe(false);
    expect(nowMarker(live('2026-09-29T04:00:00.000Z'), '2026-09-29', profile, newYork)).toEqual({
      minute: 0,
      label: 'Now 12:00 AM',
    });
  });

  it('repeats the hour at a fall-back and jumps at a spring-forward', () => {
    const fallFirst = nowMarker(live('2026-11-01T05:30:00.000Z'), '2026-11-01', profile, newYork);
    const fallSecond = nowMarker(live('2026-11-01T06:30:00.000Z'), '2026-11-01', profile, newYork);
    expect(fallFirst).toEqual(fallSecond);
    expect(fallFirst).toEqual({ minute: 90, label: 'Now 1:30 AM' });
    expect(nowMarker(live('2026-03-08T06:59:00.000Z'), '2026-03-08', profile, newYork)?.label).toBe(
      'Now 1:59 AM',
    );
    expect(nowMarker(live('2026-03-08T07:00:00.000Z'), '2026-03-08', profile, newYork)).toEqual({
      minute: 180,
      label: 'Now 3:00 AM',
    });
  });
});
