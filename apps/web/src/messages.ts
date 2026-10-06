import {
  interpolateMessage,
  isPseudoLocale,
  normalizeLocaleTag,
  pseudoLocalize,
  resolveTextDirection,
  webMessages,
  type InterpolationValues,
  type WebMessageId,
} from '@yelaxis/i18n';

/** Device locale only affects presentation; canonical dates, instants, and Profile remain unchanged. */
export const uiLocale = normalizeLocaleTag(
  typeof navigator === 'undefined' ? 'en' : navigator.language,
);
/** The shipped catalog is English; locale formatting does not imply translated interface copy. */
export const interfaceLanguage = isPseudoLocale(uiLocale) ? uiLocale : 'en';
export const uiDirection = resolveTextDirection(interfaceLanguage);

export function message(id: WebMessageId, values?: InterpolationValues): string {
  const source = webMessages[id];
  return interpolateMessage(isPseudoLocale(uiLocale) ? pseudoLocalize(source) : source, values);
}

// One configuration per immutable document locale. Counts and formatted values are never retained.
let countPluralRules: Intl.PluralRules | undefined;
let countNumberFormat: Intl.NumberFormat | undefined;

/** Uses Intl plural categories; the English source falls back to its other form for new locales. */
export function countMessage(count: number, one: WebMessageId, other: WebMessageId): string {
  countPluralRules ??= new Intl.PluralRules('en');
  countNumberFormat ??= new Intl.NumberFormat(uiLocale);
  return message(countPluralRules.select(count) === 'one' ? one : other, {
    count: countNumberFormat.format(count),
  });
}
