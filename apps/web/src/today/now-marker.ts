import { message as uiMessage } from '../messages';
/**
 * The current-time marker on Today's timeline. It appears only when the viewed
 * date is the live planning today, sits at the wall-clock minute of now in the planning zone (so it
 * repeats an hour at a fall-back and jumps at a spring-forward), and names that zone only when the
 * device is in another one. The marker line is decorative; its text says the same thing.
 */
import type { PlanProfile } from '@yelaxis/application';
import type { CalendarDate } from '@yelaxis/domain';

import { formatWallTime } from '../plan/format';
import type { LiveNow } from './live-clock';

/** What the timeline draws: the minute after local midnight and the visible text. */
export interface NowMarker {
  readonly minute: number;
  readonly label: string;
}

/** The timeline shows hours from 06:00 unless something (or now) is earlier. */
export const earlyHoursEndMinute = 6 * 60;

/** Before 06:00 the timeline shows its early hours so the marker is visible. */
export const showsEarlyHours = (minute: number): boolean => minute < earlyHoursEndMinute;

/** The device zone, or undefined where the platform cannot say. */
export function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** "Now 9:05 AM", plus " in {zone}" when the device zone differs from the planning zone. */
export function nowLabel(
  live: Pick<LiveNow, 'wallTime'>,
  profile: Pick<PlanProfile, 'planningTimeZone' | 'timeFormat'>,
  deviceZone: string | undefined,
): string {
  const time = formatWallTime(live.wallTime, profile.timeFormat);
  const zone =
    deviceZone !== undefined && deviceZone !== profile.planningTimeZone
      ? uiMessage('plan.occurrence-controls.1277', { value0: profile.planningTimeZone })
      : '';
  return uiMessage('release.labels.43', { value0: time, value1: zone });
}

/** The marker for a viewed date, or undefined unless that date is the live planning today. */
export function nowMarker(
  live: LiveNow,
  viewedDate: CalendarDate | string,
  profile: Pick<PlanProfile, 'planningTimeZone' | 'timeFormat'>,
  deviceZone: string | undefined = deviceTimeZone(),
): NowMarker | undefined {
  if (viewedDate !== live.date) return undefined;
  return { minute: live.minuteOfDay, label: nowLabel(live, profile, deviceZone) };
}
