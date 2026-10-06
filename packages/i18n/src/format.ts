import {
  englishCatalog,
  type MessageCatalog,
  type MessageId,
  type PartialMessageCatalog,
} from './catalog';
import {
  normalizeLocaleTag,
  resolveTextDirection,
  type DirectionPreference,
  type TextDirection,
} from './direction';
import { isPseudoLocale, pseudoLocalize } from './pseudo';

const interpolationPattern = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

export type InterpolationValue = string | number | bigint;
export type InterpolationValues = Readonly<Record<string, InterpolationValue | undefined>>;

export interface LocaleWeekInfo {
  /** Monday is 1 and Sunday is 7, following the Intl.Locale convention. */
  readonly firstDay: number;
  readonly weekend: readonly number[];
  readonly minimalDays: number;
}

interface RuntimeWeekInfo {
  readonly firstDay: number;
  readonly weekend: readonly number[];
  readonly minimalDays?: number;
}

interface LocaleWeekInfoAccess {
  readonly weekInfo?: RuntimeWeekInfo;
  getWeekInfo?: () => RuntimeWeekInfo;
}

export type TranslationIssue =
  | {
      readonly kind: 'missing_message';
      readonly messageId: MessageId;
    }
  | {
      readonly kind: 'missing_interpolation_value';
      readonly messageId: MessageId;
      readonly placeholder: string;
    };

export interface CreateI18nOptions {
  readonly locale: string;
  readonly messages?: PartialMessageCatalog;
  readonly fallbackCatalog?: MessageCatalog;
  readonly direction?: DirectionPreference;
  readonly onIssue?: (issue: TranslationIssue) => void;
}

export interface I18n {
  readonly locale: string;
  readonly direction: TextDirection;
  t(messageId: MessageId, values?: InterpolationValues): string;
  formatNumber(value: number | bigint, options?: Intl.NumberFormatOptions): string;
  formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  formatTime(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  formatList(values: readonly string[], options?: Intl.ListFormatOptions): string;
  selectPlural(value: number, options?: Intl.PluralRulesOptions): Intl.LDMLPluralRule;
  getWeekInfo(): LocaleWeekInfo;
}

export function getMessagePlaceholders(message: string): readonly string[] {
  const placeholders = new Set<string>();

  for (const match of message.matchAll(interpolationPattern)) {
    const placeholder = match[1];
    if (placeholder !== undefined) {
      placeholders.add(placeholder);
    }
  }

  return [...placeholders];
}

export function interpolateMessage(
  message: string,
  values: InterpolationValues = {},
  onMissingValue?: (placeholder: string) => void,
): string {
  return message.replace(interpolationPattern, (token: string, placeholder: string) => {
    const value = values[placeholder];

    if (value === undefined) {
      onMissingValue?.(placeholder);
      return token;
    }

    return String(value);
  });
}

export function createI18n(options: CreateI18nOptions): I18n {
  const locale = normalizeLocaleTag(options.locale);
  const direction = resolveTextDirection(locale, options.direction);
  const fallbackCatalog = options.fallbackCatalog ?? englishCatalog;
  const shouldPseudoLocalize = isPseudoLocale(locale);

  return {
    locale,
    direction,
    t(messageId, values = {}) {
      const override = options.messages?.[messageId];
      const hasOverride = override !== undefined && override.trim().length > 0;

      if (options.messages !== undefined && !hasOverride) {
        options.onIssue?.({ kind: 'missing_message', messageId });
      }

      const resolvedMessage = hasOverride ? override : fallbackCatalog[messageId];
      const message = shouldPseudoLocalize ? pseudoLocalize(resolvedMessage) : resolvedMessage;

      return interpolateMessage(message, values, (placeholder) => {
        options.onIssue?.({
          kind: 'missing_interpolation_value',
          messageId,
          placeholder,
        });
      });
    },
    formatNumber(value, formatOptions) {
      return new Intl.NumberFormat(locale, formatOptions).format(value);
    },
    formatDate(value, formatOptions) {
      return new Intl.DateTimeFormat(locale, formatOptions).format(value);
    },
    formatTime(value, formatOptions) {
      return new Intl.DateTimeFormat(locale, {
        hour: 'numeric',
        minute: '2-digit',
        ...formatOptions,
      }).format(value);
    },
    formatList(values, formatOptions) {
      return new Intl.ListFormat(locale, formatOptions).format(values);
    },
    selectPlural(value, formatOptions) {
      return new Intl.PluralRules(locale, formatOptions).select(value);
    },
    getWeekInfo() {
      return getLocaleWeekInfo(locale);
    },
  };
}

export function getLocaleWeekInfo(locale: string): LocaleWeekInfo {
  const parsedLocale = new Intl.Locale(normalizeLocaleTag(locale));
  const weekInfoAccess = parsedLocale as unknown as LocaleWeekInfoAccess;
  const runtimeWeekInfo = weekInfoAccess.weekInfo ?? weekInfoAccess.getWeekInfo?.();

  if (runtimeWeekInfo === undefined) {
    return { firstDay: 1, weekend: [6, 7], minimalDays: 4 };
  }

  return {
    firstDay: runtimeWeekInfo.firstDay,
    weekend: [...runtimeWeekInfo.weekend],
    minimalDays: runtimeWeekInfo.minimalDays ?? 4,
  };
}
