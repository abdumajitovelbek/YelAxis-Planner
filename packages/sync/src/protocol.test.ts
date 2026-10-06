import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalJson, documentHash } from './protocol';

const vectors: readonly Readonly<Record<string, unknown>>[] = [
  {},
  { title: 'Write the plan', state: 'planned', orderKey: '000000001' },
  { b: 1, a: { d: [3, { z: null, y: 'é' }], c: 'tab\tquote"' }, skipped: undefined },
  { emoji: 'Plan 🌱', unicode: 'naïve – “quotes”', escape: ' line' },
  { nested: [{ k2: 2, k1: 1 }, [true, false, 0.5, -1e-7]] },
];

describe('the snapshot hash shared with the server', () => {
  it('sorts keys at every depth, drops undefined members, and adds no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: undefined }] } })).toBe(
      '{"a":{"c":[{"z":1}],"d":2},"b":1}',
    );
  });

  it.each(vectors.map((vector, index) => [index, vector] as const))(
    'matches Node SHA-256 of the canonical JSON (vector %i)',
    async (_index, vector) => {
      const expected = createHash('sha256').update(canonicalJson(vector), 'utf8').digest('hex');
      await expect(documentHash(vector)).resolves.toBe(expected);
    },
  );
});
