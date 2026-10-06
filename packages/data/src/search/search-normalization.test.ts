import { describe, expect, it } from 'vitest';
import { normalizeSearchText } from './search-normalization';
describe('deterministic Unicode search normalization', () => {
  it('normalizes equivalent Unicode, letter case, punctuation, and whitespace', () => {
    expect(normalizeSearchText(' CAFÉ—СЛОН\nＫＥＹ foo_bar % "quote" ')).toBe(
      'café слон key foo bar quote',
    );
    expect(normalizeSearchText('cafe\u0301')).toBe('café');
    expect(normalizeSearchText(null)).toBe('');
  });
});
