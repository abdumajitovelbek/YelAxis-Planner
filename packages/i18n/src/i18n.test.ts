import { describe, expect, it, vi } from 'vitest';

import { englishCatalog, getMissingMessageIds, messageIds } from './catalog';
import {
  detectTextDirection,
  logicalHorizontalEdges,
  logicalInlineOffset,
  normalizeLocaleTag,
  resolveTextDirection,
} from './direction';
import { createI18n, getMessagePlaceholders, interpolateMessage } from './format';
import {
  isPseudoLocale,
  leftToRightPseudoLocale,
  pseudoLocalize,
  rightToLeftPseudoLocale,
} from './pseudo';

describe('message catalog', () => {
  it('keeps the English source catalog complete and non-empty', () => {
    expect(getMissingMessageIds(englishCatalog)).toEqual([]);
    expect(messageIds).toHaveLength(Object.keys(englishCatalog).length);
    expect(new Set(messageIds).size).toBe(messageIds.length);
    expect(Object.values(englishCatalog).every((message) => message.trim().length > 0)).toBe(true);
  });

  it('detects missing and blank messages in development catalogs', () => {
    const missing = getMissingMessageIds({
      'app.name': 'YelAxis Planner',
      'app.tagline': '   ',
    });

    expect(missing).not.toContain('app.name');
    expect(missing).toContain('app.tagline');
    expect(missing).toContain('navigation.today.label');
  });

  it('keeps shell copy within the manual planning boundary', () => {
    expect(Object.values(englishCatalog).join(' ')).not.toMatch(/\b(?:AI|calendar)\b/i);
  });
});

describe('translation and formatting boundary', () => {
  it('uses locale overrides and reports fallback to English', () => {
    const onIssue = vi.fn();
    const i18n = createI18n({
      locale: 'uz-Latn-UZ',
      messages: { 'app.name': 'YelAxis Planner' },
      onIssue,
    });

    expect(i18n.t('app.name')).toBe('YelAxis Planner');
    expect(i18n.t('action.close')).toBe(englishCatalog['action.close']);
    expect(onIssue).toHaveBeenCalledWith({
      kind: 'missing_message',
      messageId: 'action.close',
    });
  });

  it('interpolates known values and preserves missing placeholders visibly', () => {
    const onIssue = vi.fn();
    const i18n = createI18n({ locale: 'en', onIssue });

    expect(getMessagePlaceholders(englishCatalog['accessibility.progress'])).toEqual([
      'completed',
      'total',
    ]);
    expect(i18n.t('accessibility.selected', { label: 'Today' })).toBe('Today, selected');
    expect(i18n.t('accessibility.progress', { completed: 2 })).toBe('2 of {total} complete');
    expect(onIssue).toHaveBeenCalledWith({
      kind: 'missing_interpolation_value',
      messageId: 'accessibility.progress',
      placeholder: 'total',
    });
    expect(interpolateMessage('{count} item', { count: 0 })).toBe('0 item');
  });

  it('delegates numbers, dates, time, lists, plurals, and week rules to Intl', () => {
    const locale = 'en-GB';
    const date = Date.UTC(2026, 6, 23, 14, 5);
    const i18n = createI18n({ locale });

    expect(i18n.formatNumber(12_345.6)).toBe(new Intl.NumberFormat(locale).format(12_345.6));
    expect(i18n.formatDate(date, { dateStyle: 'medium', timeZone: 'UTC' })).toBe(
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date),
    );
    expect(i18n.formatTime(date, { timeZone: 'UTC' })).toBe(
      new Intl.DateTimeFormat(locale, {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'UTC',
      }).format(date),
    );
    expect(i18n.formatList(['Today', 'Plan'])).toBe(
      new Intl.ListFormat(locale).format(['Today', 'Plan']),
    );
    expect(i18n.selectPlural(1)).toBe(new Intl.PluralRules(locale).select(1));
    expect(i18n.getWeekInfo().firstDay).toBeGreaterThanOrEqual(1);
    expect(i18n.getWeekInfo().firstDay).toBeLessThanOrEqual(7);
  });
});

describe('direction and pseudo-localization', () => {
  it('normalizes invalid input and identifies locale direction', () => {
    expect(normalizeLocaleTag('  ')).toBe('en');
    expect(normalizeLocaleTag('not_a_locale')).toBe('en');
    expect(detectTextDirection('en')).toBe('ltr');
    expect(detectTextDirection('ru')).toBe('ltr');
    expect(detectTextDirection('uz-Latn')).toBe('ltr');
    expect(detectTextDirection('uz-Arab')).toBe('rtl');
    expect(detectTextDirection('ar')).toBe('rtl');
    expect(detectTextDirection('he')).toBe('rtl');
    expect(resolveTextDirection('ar', 'ltr')).toBe('ltr');
  });

  it('maps logical values without embedding physical-direction assumptions', () => {
    expect(logicalHorizontalEdges('start', 'end', 'ltr')).toEqual({
      left: 'start',
      right: 'end',
    });
    expect(logicalHorizontalEdges('start', 'end', 'rtl')).toEqual({
      left: 'end',
      right: 'start',
    });
    expect(logicalInlineOffset(8, 'ltr')).toBe(8);
    expect(logicalInlineOffset(8, 'rtl')).toBe(-8);
  });

  it('preserves placeholders and supports both development pseudo-locales', () => {
    expect(isPseudoLocale(leftToRightPseudoLocale)).toBe(true);
    expect(isPseudoLocale(rightToLeftPseudoLocale)).toBe(true);
    expect(createI18n({ locale: leftToRightPseudoLocale }).direction).toBe('ltr');
    expect(createI18n({ locale: rightToLeftPseudoLocale }).direction).toBe('rtl');

    const pseudoMessage = pseudoLocalize('Hello {name}');
    expect(pseudoMessage).toContain('{name}');
    expect(pseudoMessage).not.toContain('Hello');
    expect(
      createI18n({ locale: leftToRightPseudoLocale }).t('accessibility.selected', {
        label: 'Today',
      }),
    ).toContain('Today');
  });
});
