import { expect, it } from 'vitest';
import { imageHealthProof, matchesHealthProof } from './health-proof';

const policy = 'a'.repeat(40);
it('matches native SHA-256 across chunk boundaries and exact subarray limits without mutating source bytes', async () => {
  const allocation = Uint8Array.from({ length: 3 * 64 * 1024 + 31 }, (_, index) => index % 251);
  const view = allocation.subarray(17, allocation.length - 9);
  const before = allocation.slice();
  const proof = await imageHealthProof(view, policy, '3.44.0');
  const native = new Uint8Array(await crypto.subtle.digest('SHA-256', view));
  expect(proof.sha256).toBe([...native].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
  expect(proof.imageByteLength).toBe(view.byteLength);
  expect(allocation).toEqual(before);
});
it('binds successful health results to every image byte, policy and engine without retaining prose', async () => {
  const bytes = new Uint8Array([17, 23, 31]);
  const proof = await imageHealthProof(bytes, policy, '3.44.0');
  expect(matchesHealthProof(structuredClone(proof), proof)).toBe(true);
  bytes[1] = 29;
  expect(matchesHealthProof(proof, await imageHealthProof(bytes, policy, '3.44.0'))).toBe(false);
  expect(matchesHealthProof(proof, await imageHealthProof(bytes, 'b'.repeat(40), '3.44.0'))).toBe(
    false,
  );
  expect(matchesHealthProof(proof, { ...proof, sqliteVersion: 'next' })).toBe(false);
  expect(matchesHealthProof(proof, { ...proof, imageByteLength: 4 })).toBe(false);
  expect(Object.keys(proof).sort()).toEqual([
    'format',
    'imageByteLength',
    'policy',
    'sha256',
    'sqliteVersion',
  ]);
});

it('treats malformed, extra, inherited or accessor proof fields as cache misses without executing getters', async () => {
  const proof = await imageHealthProof(new Uint8Array([1]), policy, '3.44.0');
  let calls = 0;
  const accessor = { ...proof };
  Object.defineProperty(accessor, 'sha256', {
    enumerable: true,
    get() {
      calls += 1;
      return proof.sha256;
    },
  });
  for (const candidate of [
    undefined,
    null,
    [],
    {},
    { ...proof, extra: true },
    { ...proof, sha256: 'invalid' },
    Object.create(proof),
    accessor,
    { ...proof, [Symbol('extra')]: true },
  ])
    expect(matchesHealthProof(candidate, proof)).toBe(false);
  expect(calls).toBe(0);
});
