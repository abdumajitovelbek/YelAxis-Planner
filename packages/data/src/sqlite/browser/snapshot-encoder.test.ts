import { expect, it, vi } from 'vitest';

import { retireOwnedSnapshot } from './retire-snapshot';
import { decodeSnapshotValue, encodeSnapshotValue } from './snapshot-bytes';
import { SnapshotEncoder } from './snapshot-encoder';

it('propagates compression failure without replacing the prior usable image', async () => {
  const failure = new Error('compression unavailable');
  const compress = vi.fn(encodeSnapshotValue);
  const encoder = new SnapshotEncoder(compress);
  const before = await encoder.encode(new Uint8Array([1]));
  compress.mockRejectedValueOnce(failure);
  await expect(encoder.encode(new Uint8Array([2]))).rejects.toBe(failure);
  expect(await decodeSnapshotValue(before)).toEqual(new Uint8Array([1]));
  expect(await decodeSnapshotValue(await encoder.encode(new Uint8Array([1])))).toEqual(
    new Uint8Array([1]),
  );
  expect(compress).toHaveBeenCalledTimes(2);
});

it('compresses an unchanged exact image once, excluding private prefix and spare bytes', async () => {
  const compress = vi.fn(encodeSnapshotValue);
  const encoder = new SnapshotEncoder(compress);
  const allocation = new Uint8Array([91, 83, 81, 76, 94]);
  const first = await encoder.encode(allocation.subarray(1, 4));
  allocation[0] = 0;
  allocation[4] = 0;
  const second = await encoder.encode(allocation.subarray(1, 4));
  expect(compress).toHaveBeenCalledTimes(1);
  expect(second.bytes).not.toBe(first.bytes);
  expect(await decodeSnapshotValue(first)).toEqual(new Uint8Array([83, 81, 76]));
  expect(await decodeSnapshotValue(second)).toEqual(new Uint8Array([83, 81, 76]));
});

it('recompresses changed bytes and preserves independently held rollback images', async () => {
  const compress = vi.fn(encodeSnapshotValue);
  const encoder = new SnapshotEncoder(compress);
  const image = new Uint8Array([83, 81, 76]);
  const before = await encoder.encode(image);
  image[2] = 77;
  const after = await encoder.encode(image);
  expect(compress).toHaveBeenCalledTimes(2);
  expect(await decodeSnapshotValue(before)).toEqual(new Uint8Array([83, 81, 76]));
  expect(await decodeSnapshotValue(after)).toEqual(image);
  encoder.clear();
  expect(await decodeSnapshotValue(after)).toEqual(image);
  await encoder.encode(image);
  expect(compress).toHaveBeenCalledTimes(3);
});

it('keeps the cached image usable after a caller retires its private rollback copy', async () => {
  const compress = vi.fn(encodeSnapshotValue);
  const encoder = new SnapshotEncoder(compress);
  const image = new Uint8Array([83, 81, 76]);
  const before = await encoder.encode(image);
  retireOwnedSnapshot(new Uint8Array(before.bytes));
  const after = await encoder.encode(image);
  expect(compress).toHaveBeenCalledTimes(1);
  expect(await decodeSnapshotValue(after)).toEqual(image);
});

it('falls back to normal compression when hashing fails, never reusing a stale image', async () => {
  const compress = vi.fn(encodeSnapshotValue);
  const digest = vi
    .fn<(bytes: Uint8Array) => Promise<string>>()
    .mockResolvedValueOnce('first')
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValueOnce('first');
  const encoder = new SnapshotEncoder(compress, digest);
  await encoder.encode(new Uint8Array([1]));
  expect(await decodeSnapshotValue(await encoder.encode(new Uint8Array([2])))).toEqual(
    new Uint8Array([2]),
  );
  expect(await decodeSnapshotValue(await encoder.encode(new Uint8Array([1])))).toEqual(
    new Uint8Array([1]),
  );
  expect(compress).toHaveBeenCalledTimes(3);
});
