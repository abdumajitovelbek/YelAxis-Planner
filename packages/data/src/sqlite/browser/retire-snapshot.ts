/** Retire private before-images after settlement, or VFS allocations after SQLite closes all handles. */
export function retireOwnedSnapshot(bytes: Uint8Array): void {
  const buffer = bytes.buffer as ArrayBuffer & { transfer?: (length: number) => ArrayBuffer };
  // Older engines fall back to ordinary garbage collection. Never detach a live canonical VFS image.
  if (buffer instanceof ArrayBuffer && buffer.byteLength > 0 && buffer.transfer !== undefined) {
    buffer.transfer(0);
  }
}
