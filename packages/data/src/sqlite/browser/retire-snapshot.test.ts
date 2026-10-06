import { expect, it } from 'vitest';
import { retireOwnedSnapshot } from './retire-snapshot';

it('retires an owned before-image after restoration without detaching canonical bytes', () => {
  const before = new Uint8Array([17, 23, 31]);
  // Restoration owns a defensive copy; the original backup can now be released immediately.
  const restored = before.slice();
  retireOwnedSnapshot(before);
  expect(before.byteLength).toBe(0);
  expect([...restored]).toEqual([17, 23, 31]);
  retireOwnedSnapshot(before);
  expect([...restored]).toEqual([17, 23, 31]);
});

it('retains bytes for ordinary collection when the engine cannot transfer buffers', () => {
  const before = new Uint8Array([41, 43]);
  Object.defineProperty(before.buffer, 'transfer', { value: undefined });
  retireOwnedSnapshot(before);
  expect([...before]).toEqual([41, 43]);
});
