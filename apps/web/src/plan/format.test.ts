import { afterEach, expect, it, vi } from 'vitest';

import type { Instant } from '@yelaxis/domain';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function formats(locale = 'en-US') {
  vi.stubGlobal('navigator', { language: locale });
  vi.resetModules();
  return { ...(await import('./format')), ...(await import('../messages')) };
}

it.each(['en-US', 'de-DE', 'ar-EG'])(
  'preserves native date, month, weekday and wall-time output for %s',
  async (locale) => {
    const value = await formats(locale);
    const date = '2026-11-01';
    const noon = new Date(`${date}T12:00:00Z`);
    const styles = {
      long: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
      medium: { month: 'short', day: 'numeric', year: 'numeric' },
      short: { month: 'short', day: 'numeric' },
      weekday: { weekday: 'short', month: 'short', day: 'numeric' },
    } as const;
    for (const [style, options] of Object.entries(styles)) {
      expect(value.formatDate(date, style as keyof typeof styles)).toBe(
        new Intl.DateTimeFormat(value.uiLocale, { ...options, timeZone: 'UTC' }).format(noon),
      );
    }
    expect(value.formatWeekday(date)).toBe(
      new Intl.DateTimeFormat(value.uiLocale, { weekday: 'long', timeZone: 'UTC' }).format(noon),
    );
    expect(value.formatMonth('2026-11')).toBe(
      new Intl.DateTimeFormat(value.uiLocale, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date('2026-11-01T12:00:00Z')),
    );
    expect(value.formatMonthShort('2026-11')).toBe(
      new Intl.DateTimeFormat(value.uiLocale, { month: 'short', timeZone: 'UTC' }).format(noon),
    );
    for (const time of ['00:00', '09:05', '12:00', '23:59']) {
      const [hour, minute] = time.split(':').map(Number);
      expect(value.formatWallTime(time, '24_hour')).toBe(time);
      expect(value.formatWallTime(time, '12_hour')).toBe(
        new Intl.DateTimeFormat(value.uiLocale, {
          timeZone: 'UTC',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(new Date(Date.UTC(2000, 0, 1, hour, minute))),
      );
    }
  },
);

it.each(['en-US', 'de-DE', 'ar-EG'])(
  'keeps instant zones and 12/24-hour formats distinct for %s through DST',
  async (locale) => {
    const value = await formats(locale);
    for (const instant of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'] as Instant[]) {
      for (const timeZone of ['UTC', 'America/New_York', 'Asia/Tashkent']) {
        for (const format of ['12_hour', '24_hour'] as const) {
          expect(value.formatInstantTime(instant, timeZone, format)).toBe(
            new Intl.DateTimeFormat(value.uiLocale, {
              timeZone,
              hour: 'numeric',
              minute: '2-digit',
              hour12: format === '12_hour',
            }).format(new Date(instant)),
          );
        }
      }
    }
  },
);

it('reuses formatters across dense conflict renders instead of caching planning values', async () => {
  const value = await formats();
  const NativeFormat = Intl.DateTimeFormat;
  const construct = vi
    .spyOn(Intl, 'DateTimeFormat')
    .mockImplementation(function (locales, options) {
      return new NativeFormat(locales, options);
    });
  for (let index = 0; index < 150; index++) {
    value.formatDate(`2026-11-${String((index % 28) + 1).padStart(2, '0')}`, 'weekday');
    value.formatInstantTime('2026-11-01T05:30:00Z' as Instant, 'America/New_York', '24_hour');
    value.formatWallTime(`${String(index % 24).padStart(2, '0')}:05`, '12_hour');
  }
  expect(construct).toHaveBeenCalledTimes(3);
});

it('evicts stale zone configurations while retaining recent formatter reuse', async () => {
  const value = await formats();
  const instant = '2026-11-01T05:30:00Z' as Instant;
  const NativeFormat = Intl.DateTimeFormat;
  const construct = vi
    .spyOn(Intl, 'DateTimeFormat')
    .mockImplementation(function (locales, options) {
      return new NativeFormat(locales, options);
    });
  // Distinct valid zone/format pairs exceed the bounded presentation cache.
  const zones = Array.from(
    { length: 21 },
    (_, index) => `Etc/GMT${index - 10 < 0 ? '' : '+'}${index - 10}`,
  );
  for (const zone of zones) {
    value.formatInstantTime(instant, zone, '12_hour');
    value.formatInstantTime(instant, zone, '24_hour');
  }
  expect(construct).toHaveBeenCalledTimes(42);
  value.formatInstantTime(instant, zones.at(-1) ?? 'UTC', '24_hour');
  expect(construct).toHaveBeenCalledTimes(42);
  value.formatInstantTime(instant, zones[0] ?? 'UTC', '12_hour');
  expect(construct).toHaveBeenCalledTimes(43);
});
