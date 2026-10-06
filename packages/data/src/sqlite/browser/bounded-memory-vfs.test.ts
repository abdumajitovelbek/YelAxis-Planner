import * as SQLite from 'wa-sqlite';
import { expect, it } from 'vitest';

import { BoundedMemoryVFS } from './bounded-memory-vfs';

it('refuses to retire live files, then releases closed private allocations without changing the durable copy', () => {
  const vfs = new BoundedMemoryVFS();
  const io = vfs as unknown as SQLiteVFS;
  const bytes = new Uint8Array([17, 23, 31]);
  const durable = bytes.slice();
  const file = {
    name: 'plan',
    flags: SQLite.SQLITE_OPEN_READWRITE,
    size: bytes.length,
    data: bytes.buffer,
  };
  vfs.mapNameToFile.set('plan', file);
  io.xOpen('plan', 1, file.flags, new DataView(new ArrayBuffer(4)));
  expect(() => vfs.retireClosedFiles()).toThrow();
  expect([...bytes]).toEqual([17, 23, 31]);
  io.xClose(1);
  vfs.retireClosedFiles();
  expect(bytes.byteLength).toBe(0);
  expect([...durable]).toEqual([17, 23, 31]);
  expect(vfs.mapNameToFile.size).toBe(0);
  vfs.retireClosedFiles();
});

it('preserves existing and appended bytes without doubling a large reopened image', () => {
  const vfs = new BoundedMemoryVFS();
  const io = vfs as unknown as SQLiteVFS;
  const image = new Uint8Array(8 * 1024 * 1024);
  image[0] = 17;
  image[image.length - 1] = 23;
  const originalLength = image.length;
  const acknowledgedCopy = image.slice();
  const file = {
    name: 'plan',
    flags: SQLite.SQLITE_OPEN_READWRITE,
    size: image.length,
    data: image.buffer,
  };
  vfs.mapNameToFile.set('plan', file);
  expect(io.xOpen('plan', 1, file.flags, new DataView(new ArrayBuffer(4)))).toBe(SQLite.SQLITE_OK);
  expect(vfs.xWrite(1, new Uint8Array([31, 37]), originalLength)).toBe(SQLite.SQLITE_OK);
  expect(file.size).toBe(originalLength + 2);
  expect(file.data.byteLength).toBeLessThanOrEqual(originalLength + 1024 * 1024);
  expect(image.byteLength).toBe(0);
  expect(acknowledgedCopy.length).toBe(originalLength);
  expect(acknowledgedCopy[0]).toBe(17);
  expect(acknowledgedCopy[originalLength - 1]).toBe(23);
  const tail = new Uint8Array(3);
  expect(io.xRead(1, tail, originalLength - 1)).toBe(SQLite.SQLITE_OK);
  expect([...tail]).toEqual([23, 31, 37]);
  const head = new Uint8Array(1);
  io.xRead(1, head, 0);
  expect(head[0]).toBe(17);
  io.xTruncate(1, originalLength);
  const clipped = new Uint8Array(3).fill(99);
  expect(io.xRead(1, clipped, originalLength - 1)).toBe(SQLite.SQLITE_IOERR_SHORT_READ);
  expect([...clipped]).toEqual([23, 0, 0]);
  io.xClose(1);
});

it('permits writes beyond an increment without imposing a canonical file-size limit', () => {
  const vfs = new BoundedMemoryVFS();
  const io = vfs as unknown as SQLiteVFS;
  io.xOpen(
    'plan',
    1,
    SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE,
    new DataView(new ArrayBuffer(4)),
  );
  const offset = 3 * 1024 * 1024;
  expect(vfs.xWrite(1, new Uint8Array([41]), offset)).toBe(SQLite.SQLITE_OK);
  const gap = new Uint8Array(3);
  expect(io.xRead(1, gap, offset - 2)).toBe(SQLite.SQLITE_OK);
  expect([...gap]).toEqual([0, 0, 41]);
  const length = new DataView(new ArrayBuffer(8));
  io.xFileSize(1, length);
  expect(length.getBigInt64(0, true)).toBe(BigInt(offset + 1));
  io.xClose(1);
});
