import { encodeSnapshotValue, type EncodedSnapshot } from './snapshot-bytes';
import { retireOwnedSnapshot } from './retire-snapshot';

async function imageDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** One worker-owned compressed image; callers always receive independently owned bytes. */
export class SnapshotEncoder {
  #cached: { readonly digest: string; readonly image: EncodedSnapshot } | undefined;
  constructor(
    private readonly compress = encodeSnapshotValue,
    private readonly digest = imageDigest,
  ) {}

  async encode(bytes: Uint8Array): Promise<EncodedSnapshot> {
    let digest: string;
    try {
      digest = await this.digest(bytes);
    } catch {
      // Hashing only accelerates compression; it never changes durability or authorizes an image.
      this.clear();
      return this.compress(bytes);
    }
    if (
      this.#cached?.digest !== digest ||
      this.#cached.image.imageByteLength !== bytes.byteLength
    ) {
      const image = await this.compress(bytes);
      this.clear();
      this.#cached = { digest, image };
    }
    const image = this.#cached.image;
    // Rollback settlement may detach its before-image. Never share that buffer with this cache.
    return { ...image, bytes: image.bytes.slice(0) };
  }

  clear(): void {
    if (this.#cached) retireOwnedSnapshot(new Uint8Array(this.#cached.image.bytes));
    this.#cached = undefined;
  }
}
