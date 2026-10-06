import { describe, expect, it } from 'vitest';

import { detectDeviceDefaults } from './device-defaults';

describe('detectDeviceDefaults', () => {
  it('reads 12- or 24-hour time from the locale, not from a date-only formatter', () => {
    expect(detectDeviceDefaults('en-US', 'America/New_York')).toEqual({
      planningTimeZone: 'America/New_York',
      weekStart: 'sunday',
      timeFormat: '12_hour',
      locale: 'en-US',
    });
    expect(detectDeviceDefaults('en-GB', 'Europe/London')).toMatchObject({
      weekStart: 'monday',
      timeFormat: '24_hour',
    });
    expect(detectDeviceDefaults('de-DE', 'Europe/Berlin').timeFormat).toBe('24_hour');
  });

  it('falls back to UTC when the device reports no time zone', () => {
    expect(detectDeviceDefaults('en-GB', '').planningTimeZone).toBe('UTC');
  });
});
