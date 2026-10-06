/** IndexedDB clones synchronously. Reuse only an exact buffer; never serialize spare/private bytes. */
export function exactSnapshotBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
}

/** Blob owns immutable exact bytes; IndexedDB stores a file handle rather than a giant inline value. */
export function snapshotBlob(bytes: Uint8Array): Blob {
  const part =
    bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice();
  return new Blob([part], { type: 'application/vnd.sqlite3' });
}

export type EncodedSnapshot = Readonly<{
  format: 'sqlite-gzip-v1';
  imageByteLength: number;
  bytes: ArrayBuffer;
}>;

const streamChunkBytes = 64 * 1024;

/**
 * The worker retains exclusive ownership of a stable input until this resolves. Only individual
 * 64 KiB chunks are copied; never allocate a second whole input image or an input Blob/Response.
 * The resulting compressed buffer owns its bytes independently of the input allocation.
 */
export async function encodeSnapshotValue(bytes: Uint8Array): Promise<EncodedSnapshot> {
  const reader = chunkStream(bytes).pipeThrough(new CompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      chunks.push(item.value);
      length += item.value.byteLength;
    }
    const compressed = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      compressed.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      format: 'sqlite-gzip-v1',
      imageByteLength: bytes.byteLength,
      bytes: compressed.buffer,
    };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Existing ArrayBuffer/Uint8Array snapshots remain readable without rewriting or resetting them. */
export async function decodeSnapshotValue(value: unknown): Promise<Uint8Array | undefined> {
  try {
    if (value === undefined) return undefined;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value instanceof Uint8Array) return value;
    if (value instanceof Blob) return new Uint8Array(await Blob.prototype.arrayBuffer.call(value));
    const encoded = snapshotEnvelope(value);
    const output = new Uint8Array(encoded.imageByteLength);
    const reader = chunkStream(new Uint8Array(encoded.bytes))
      .pipeThrough(new DecompressionStream('gzip'))
      .getReader();
    let offset = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        if (item.value.byteLength > output.byteLength - offset) {
          throw new Error('invalid_snapshot_format');
        }
        output.set(item.value, offset);
        offset += item.value.byteLength;
      }
      if (offset !== output.byteLength) throw new Error('invalid_snapshot_format');
      return output;
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  } catch {
    // Do not expose payloads or native decompressor diagnostics; never return a partial image.
    throw new Error('invalid_snapshot_format');
  }
}

function snapshotEnvelope(value: unknown): EncodedSnapshot {
  if (value === null || typeof value !== 'object') throw new Error('invalid_snapshot_format');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('invalid_snapshot_format');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3 ||
    !keys.every((key) => key === 'format' || key === 'imageByteLength' || key === 'bytes')
  ) {
    throw new Error('invalid_snapshot_format');
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    const field = fields[key as string];
    if (field === undefined || !Object.hasOwn(field, 'value') || !field.enumerable)
      throw new Error('invalid_snapshot_format');
  }
  const format: unknown = fields['format']?.value;
  const length: unknown = fields['imageByteLength']?.value;
  const bytes: unknown = fields['bytes']?.value;
  if (
    format !== 'sqlite-gzip-v1' ||
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    !(bytes instanceof ArrayBuffer)
  ) {
    throw new Error('invalid_snapshot_format');
  }
  return { format, imageByteLength: length, bytes };
}

function chunkStream(bytes: Uint8Array): ReadableStream<Uint8Array<ArrayBuffer>> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.byteLength, offset + streamChunkBytes);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
    cancel() {
      offset = bytes.byteLength;
    },
  });
}
