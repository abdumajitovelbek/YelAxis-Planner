import { expect, it, vi } from 'vitest';
import {
  decodeSnapshotValue,
  encodeSnapshotValue,
  exactSnapshotBuffer,
  snapshotBlob,
} from './snapshot-bytes';

it('excludes unrelated prefix, tail and spare allocation bytes from the persisted image', () => {
  const storage = new Uint8Array([91, 92, 83, 81, 76, 93, 94]);
  const image = exactSnapshotBuffer(storage.subarray(2, 5));
  expect([...new Uint8Array(image)]).toEqual([83, 81, 76]);
  storage.fill(0);
  expect([...new Uint8Array(image)]).toEqual([83, 81, 76]);
});

it('stores immutable exact Blob bytes without retaining private prefix or spare bytes', async () => {
  const allocation = new Uint8Array([91, 83, 81, 76, 94]);
  const value = snapshotBlob(allocation.subarray(1, 4));
  allocation.fill(0);
  expect(value.size).toBe(3);
  expect(await decodeSnapshotValue(value)).toEqual(new Uint8Array([83, 81, 76]));
});

it('still reads both legacy image formats and rejects a malformed snapshot without repair', async () => {
  const image = new Uint8Array([83, 81, 76]);
  expect(await decodeSnapshotValue(image.buffer)).toEqual(image);
  expect(await decodeSnapshotValue(image)).toEqual(image);
  expect(await decodeSnapshotValue(undefined)).toBeUndefined();
  await expect(decodeSnapshotValue('corrupt-synthetic-value')).rejects.toThrow(
    'invalid_snapshot_format',
  );
});

it('compresses exact owned bytes across chunk boundaries and restores the standard SQLite header', async () => {
  const header = new TextEncoder().encode('SQLite format 3\0');
  const allocation = new Uint8Array(64 * 1024 * 3 + 71);
  allocation.fill(251);
  const image = allocation.subarray(19, allocation.length - 23);
  image.fill(17);
  image.set(header);
  image[64 * 1024] = 29;
  image[128 * 1024] = 31;
  const expected = image.slice();
  const encoded = await encodeSnapshotValue(image);
  expect(encoded.format).toBe('sqlite-gzip-v1');
  expect(encoded.imageByteLength).toBe(image.byteLength);
  expect(encoded.bytes).toBeInstanceOf(ArrayBuffer);
  expect(encoded.bytes.byteLength).toBeLessThan(image.byteLength);
  allocation.fill(0);
  const decoded = await decodeSnapshotValue(encoded);
  expect(decoded).toEqual(expected);
  expect(decoded?.subarray(0, 16)).toEqual(header);
});

it('stores an empty image without inventing a minimum size or data cap', async () => {
  const value = await encodeSnapshotValue(new Uint8Array());
  expect(value.imageByteLength).toBe(0);
  expect(await decodeSnapshotValue(value)).toEqual(new Uint8Array());
});

it.each([0, 2, 4])(
  'refuses a decoded image whose declared byte length is %s',
  async (imageByteLength) => {
    const encoded = await encodeSnapshotValue(new Uint8Array([83, 81, 76]));
    await expect(decodeSnapshotValue({ ...encoded, imageByteLength })).rejects.toThrow(
      'invalid_snapshot_format',
    );
  },
);

it('rejects a corrupt gzip payload without returning a partial image', async () => {
  const encoded = await encodeSnapshotValue(new Uint8Array([83, 81, 76]));
  const corrupt = encoded.bytes.slice(0);
  const bytes = new Uint8Array(corrupt);
  bytes[bytes.length - 8] = (bytes[bytes.length - 8] ?? 0) ^ 255;
  await expect(decodeSnapshotValue({ ...encoded, bytes: corrupt })).rejects.toThrow(
    'invalid_snapshot_format',
  );
  await expect(
    decodeSnapshotValue({ ...encoded, bytes: encoded.bytes.slice(0, 5) }),
  ).rejects.toThrow('invalid_snapshot_format');
});

it('rejects unknown fields, unsafe lengths, unknown formats and inherited metadata', async () => {
  const encoded = await encodeSnapshotValue(new Uint8Array([83, 81, 76]));
  const invalid = [
    { ...encoded, unrelated: true },
    { ...encoded, [Symbol('hidden')]: true },
    { ...encoded, format: 'sqlite-gzip-v2' },
    { ...encoded, imageByteLength: -1 },
    { ...encoded, imageByteLength: 1.5 },
    { ...encoded, imageByteLength: Number.POSITIVE_INFINITY },
    { ...encoded, imageByteLength: Number.MAX_SAFE_INTEGER + 1 },
    { ...encoded, bytes: new Uint8Array(encoded.bytes) },
    Object.create(encoded),
  ];
  for (const value of invalid)
    await expect(decodeSnapshotValue(value)).rejects.toThrow('invalid_snapshot_format');
});

it('refuses accessor metadata without invoking the accessor', async () => {
  let observed = false;
  const encoded = await encodeSnapshotValue(new Uint8Array([83, 81, 76]));
  const value = { format: encoded.format, bytes: encoded.bytes };
  Object.defineProperty(value, 'imageByteLength', {
    enumerable: true,
    get() {
      observed = true;
      return 3;
    },
  });
  await expect(decodeSnapshotValue(value)).rejects.toThrow('invalid_snapshot_format');
  expect(observed).toBe(false);
});

it('cancels real decompression when expanded data exceeds the declared image length', async () => {
  const encoded = await encodeSnapshotValue(new Uint8Array(256 * 1024).fill(73));
  const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
  try {
    await expect(decodeSnapshotValue({ ...encoded, imageByteLength: 20 * 1024 })).rejects.toThrow(
      'invalid_snapshot_format',
    );
    expect(cancel).toHaveBeenCalled();
  } finally {
    cancel.mockRestore();
  }
});
