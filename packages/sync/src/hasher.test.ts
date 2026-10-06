/**
 * Base snapshot hashes must be identical on every replica and on the server: lowercase hex SHA-256
 * of the UTF-8 canonical JSON (keys in JavaScript default sort order at every depth, no
 * whitespace, `JSON.stringify` for keys and scalars, `undefined` members dropped).
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '@yelaxis/application';
import { describe, expect, it } from 'vitest';

import { createSnapshotHasher } from './hasher';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('canonical JSON', () => {
  it.each([
    [{}, '{}'],
    [{ b: 1, a: 2 }, '{"a":2,"b":1}'],
    [
      { z: { y: [3, { b: true, a: null }], x: 'é' } },
      '{"z":{"x":"é","y":[3,{"a":null,"b":true}]}}',
    ],
    [{ a: undefined, b: 'kept' }, '{"b":"kept"}'],
    [{ B: 1, a: 2, _: 3 }, '{"B":1,"_":3,"a":2}'],
    [{ text: 'line\nbreak "quoted"\t' }, '{"text":"line\\nbreak \\"quoted\\"\\t"}'],
    [{ n: 1.5, m: -0, big: 1e21 }, '{"big":1e+21,"m":0,"n":1.5}'],
  ])('writes %j as %s', (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });
});

describe('snapshot hash', () => {
  const hasher = createSnapshotHasher();

  it('is the SHA-256 of the canonical JSON, independent of key order', async () => {
    expect(await hasher.hash({})).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    const document = {
      title: 'Plan the week',
      state: 'inbox',
      orderKey: 'a0',
      captureOrigin: 'global_capture',
      due: { kind: 'date', date: '2026-10-05' },
    };
    const reordered = {
      due: { date: '2026-10-05', kind: 'date' },
      captureOrigin: 'global_capture',
      orderKey: 'a0',
      state: 'inbox',
      title: 'Plan the week',
    };
    const expected = sha256(
      '{"captureOrigin":"global_capture","due":{"date":"2026-10-05","kind":"date"},"orderKey":"a0","state":"inbox","title":"Plan the week"}',
    );
    expect(await hasher.hash(document)).toBe(expected);
    expect(await hasher.hash(reordered)).toBe(expected);
    expect(await hasher.hash({ title: 'Ünïcode ✓' })).toBe(sha256('{"title":"Ünïcode ✓"}'));
    expect(expected).toMatch(/^[0-9a-f]{64}$/u);
  });
});
