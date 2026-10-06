import { normalizeLocaleTag } from './direction';

export const leftToRightPseudoLocale = 'en-XA';
export const rightToLeftPseudoLocale = 'ar-XB';

const pseudoCharacters: Readonly<Record<string, string>> = {
  A: '\u00c5',
  B: '\u0181',
  C: '\u00c7',
  D: '\u00d0',
  E: '\u00cb',
  F: '\u0191',
  G: '\u011c',
  H: '\u0124',
  I: '\u00ce',
  J: '\u0134',
  K: '\u0136',
  L: '\u013b',
  M: '\u1e40',
  N: '\u00d1',
  O: '\u00d8',
  P: '\u00de',
  Q: '\u01ea',
  R: '\u0158',
  S: '\u0160',
  T: '\u0162',
  U: '\u00db',
  V: '\u1e7c',
  W: '\u0174',
  X: '\u1e8a',
  Y: '\u0176',
  Z: '\u017d',
  a: '\u00e5',
  b: '\u0180',
  c: '\u00e7',
  d: '\u00f0',
  e: '\u00eb',
  f: '\u0192',
  g: '\u011d',
  h: '\u0125',
  i: '\u00ee',
  j: '\u0135',
  k: '\u0137',
  l: '\u013c',
  m: '\u1e41',
  n: '\u00f1',
  o: '\u00f8',
  p: '\u00fe',
  q: '\u01eb',
  r: '\u0159',
  s: '\u0161',
  t: '\u0163',
  u: '\u00fb',
  v: '\u1e7d',
  w: '\u0175',
  x: '\u1e8b',
  y: '\u0177',
  z: '\u017e',
};

const placeholderPattern = /\{[A-Za-z][A-Za-z0-9_]*\}/g;

export function isPseudoLocale(locale: string): boolean {
  const normalized = normalizeLocaleTag(locale);
  return normalized === leftToRightPseudoLocale || normalized === rightToLeftPseudoLocale;
}

/**
 * Makes truncation and hard-coded copy visible while preserving interpolation
 * placeholders for the normal message formatter.
 */
export function pseudoLocalize(message: string): string {
  let cursor = 0;
  let transformed = '';

  for (const match of message.matchAll(placeholderPattern)) {
    const index = match.index;
    transformed += transformLiteral(message.slice(cursor, index));
    transformed += match[0];
    cursor = index + match[0].length;
  }

  transformed += transformLiteral(message.slice(cursor));
  // Expand literal copy by 35% so a short label and a long paragraph both expose truncation.
  // Placeholders stay intact and user-authored interpolations are never transformed.
  const literalLength = message.replace(placeholderPattern, '').length;
  const padding = '\u00b7'.repeat(Math.max(2, Math.ceil(literalLength * 0.35)));
  return `\u27e6${transformed}\u2003${padding}\u27e7`;
}

function transformLiteral(value: string): string {
  return [...value].map((character) => pseudoCharacters[character] ?? character).join('');
}
