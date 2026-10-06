import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function messages(locale = 'en-US') {
  vi.stubGlobal('navigator', { language: locale });
  vi.resetModules();
  return await import('./messages');
}

it.each(['en-US', 'de-DE', 'ar-EG'])(
  'uses native numbers and the English catalog plural categories for %s',
  async (locale) => {
    const value = await messages(locale);
    const plurals = new Intl.PluralRules('en');
    const numbers = new Intl.NumberFormat(value.uiLocale);
    for (const count of [0, 1, 2, 3, 11, 1000, 12345.6]) {
      const id = plurals.select(count) === 'one' ? 'duration.hour.one' : 'duration.hour.other';
      expect(value.countMessage(count, 'duration.hour.one', 'duration.hour.other')).toBe(
        value.message(id, { count: numbers.format(count) }),
      );
    }
  },
);

it.each(['ru-RU', 'uz-UZ', 'ar-EG'])(
  'labels English interface copy accurately with a %s device locale',
  async (locale) => {
    const value = await messages(locale);
    expect(value.uiLocale).toBe(locale);
    expect(value.interfaceLanguage).toBe('en');
    expect(value.uiDirection).toBe('ltr');
  },
);

it('retains explicit RTL pseudo-localization for layout verification', async () => {
  const value = await messages('ar-XB');
  expect(value.interfaceLanguage).toBe('ar-XB');
  expect(value.uiDirection).toBe('rtl');
  expect(value.message('duration.hour.one', { count: '1' })).not.toBe('1 hour');
});

it('reuses count formatters for an immutable document locale without caching counts', async () => {
  const value = await messages();
  const NativePlurals = Intl.PluralRules;
  const NativeNumbers = Intl.NumberFormat;
  const plurals = vi.spyOn(Intl, 'PluralRules').mockImplementation(function (locales, options) {
    return new NativePlurals(locales, options);
  });
  const numbers = vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (locales, options) {
    return new NativeNumbers(locales, options);
  });
  for (let count = 0; count < 150; count++)
    value.countMessage(count, 'duration.minute.one', 'duration.minute.other');
  expect(plurals).toHaveBeenCalledTimes(1);
  expect(numbers).toHaveBeenCalledTimes(1);
});
