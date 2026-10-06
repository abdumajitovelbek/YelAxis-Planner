import { MemoryVFS } from 'wa-sqlite/src/examples/MemoryVFS.js';
import { retireOwnedSnapshot } from './retire-snapshot';

type MemoryFile = {
  size: number;
  data: ArrayBuffer;
};

/** Bound spare allocation, not database size. SQLite and its journal keep their normal semantics. */
export class BoundedMemoryVFS extends MemoryVFS {
  /** Called only after SQLite closes every handle; persisted snapshots are independent copies. */
  retireClosedFiles(): void {
    if (this.mapIdToFile.size !== 0) throw new Error('Live SQLite files cannot be retired.');
    for (const value of this.mapNameToFile.values()) {
      const file = value as MemoryFile;
      if (file.data.byteLength > 0) retireOwnedSnapshot(new Uint8Array(file.data));
    }
    this.mapNameToFile.clear();
  }

  // Upstream Base typings describe a wrapper although the actual VFS callback passes Uint8Array.
  override xWrite(
    fileId: number,
    input: Uint8Array | { size: number; value: Uint8Array },
    offset: number,
  ): number {
    const bytes = input instanceof Uint8Array ? input : input.value;
    const file = this.mapIdToFile.get(fileId) as MemoryFile | undefined;
    if (file !== undefined && offset + bytes.byteLength > file.data.byteLength) {
      const growth = Math.min(Math.max(4096, file.data.byteLength), 1024 * 1024);
      const capacity = Math.max(offset + bytes.byteLength, file.data.byteLength + growth);
      const data = new ArrayBuffer(capacity);
      new Uint8Array(data).set(new Uint8Array(file.data, 0, file.size));
      const replaced = file.data;
      file.data = data;
      // SQLite's VFS now owns the complete replacement. Retire only the old allocation, after
      // copying; waiting for GC retains whole images during queued writes even with bounded growth.
      retireOwnedSnapshot(new Uint8Array(replaced));
    }
    return super.xWrite(fileId, bytes as unknown as Parameters<MemoryVFS['xWrite']>[1], offset);
  }
}
