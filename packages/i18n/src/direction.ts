export type TextDirection = 'ltr' | 'rtl';
export type DirectionPreference = 'auto' | TextDirection;

const rightToLeftLanguages = new Set([
  'ar',
  'ckb',
  'dv',
  'fa',
  'he',
  'ks',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi',
]);

const rightToLeftScripts = new Set([
  'Adlm',
  'Arab',
  'Hebr',
  'Mand',
  'Nkoo',
  'Rohg',
  'Samr',
  'Syrc',
  'Thaa',
]);

export function normalizeLocaleTag(locale: string): string {
  const candidate = locale.trim();
  if (candidate.length === 0) {
    return 'en';
  }

  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? 'en';
  } catch {
    return 'en';
  }
}

export function detectTextDirection(locale: string): TextDirection {
  const parsedLocale = new Intl.Locale(normalizeLocaleTag(locale));

  if (parsedLocale.script !== undefined) {
    return rightToLeftScripts.has(parsedLocale.script) ? 'rtl' : 'ltr';
  }

  return rightToLeftLanguages.has(parsedLocale.language) ? 'rtl' : 'ltr';
}

export function resolveTextDirection(
  locale: string,
  preference: DirectionPreference = 'auto',
): TextDirection {
  return preference === 'auto' ? detectTextDirection(locale) : preference;
}

export interface LogicalHorizontalEdges<T> {
  readonly left: T;
  readonly right: T;
}

/** Maps logical inline edges to physical edges at the renderer boundary. */
export function logicalHorizontalEdges<T>(
  start: T,
  end: T,
  direction: TextDirection,
): LogicalHorizontalEdges<T> {
  return direction === 'rtl' ? { left: end, right: start } : { left: start, right: end };
}

/** Mirrors an inline-axis offset while leaving vertical movement unchanged. */
export function logicalInlineOffset(offset: number, direction: TextDirection): number {
  return direction === 'rtl' ? -offset : offset;
}
