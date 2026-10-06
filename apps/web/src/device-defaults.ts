import type { OnboardingState } from '@yelaxis/application';
import { getLocaleWeekInfo } from '@yelaxis/i18n';

export type DeviceDefaults = NonNullable<OnboardingState['draft']['defaults']>;

const weekdays = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

/**
 * Planning defaults derived from the device (confirmed during setup): time zone, week start, and
 * 12- or 24-hour time. The hour cycle is read from a formatter that shows the hour; a date-only
 * formatter reports no hour cycle, which would make every locale look like 24-hour time.
 */
export function detectDeviceDefaults(
  locale: string = navigator.language || 'en',
  timeZone: string | undefined = new Intl.DateTimeFormat().resolvedOptions().timeZone,
): DeviceDefaults {
  const hourCycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions()
    .hourCycle;
  const firstDay = getLocaleWeekInfo(locale).firstDay;
  return {
    planningTimeZone: timeZone === undefined || timeZone === '' ? 'UTC' : timeZone,
    weekStart: weekdays[firstDay - 1] ?? 'monday',
    timeFormat: hourCycle === 'h11' || hourCycle === 'h12' ? '12_hour' : '24_hour',
    locale,
  };
}
