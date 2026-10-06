import { sha256 } from '@noble/hashes/sha2';

/** A checked image's digest is an integrity optimization, never an authorization/encryption claim. */
export interface HealthProof {
  readonly format: 'sqlite-health-v1';
  readonly policy: string;
  readonly sqliteVersion: string;
  readonly imageByteLength: number;
  readonly sha256: string;
}

export function matchesHealthProof(value: unknown, expected: HealthProof): boolean {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  const fields = Object.getOwnPropertyDescriptors(value);
  const expectedKeys = Object.keys(expected);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => {
      if (typeof key !== 'string' || !expectedKeys.includes(key)) return false;
      const field = fields[key];
      return (
        field !== undefined &&
        field.enumerable &&
        Object.hasOwn(field, 'value') &&
        field.value === expected[key as keyof HealthProof]
      );
    })
  );
}

export function imageHealthProof(
  bytes: Uint8Array<ArrayBuffer>,
  policy: string,
  sqliteVersion: string,
): Promise<HealthProof> {
  // SubtleCrypto clones its whole BufferSource. Hash bounded views in the worker instead, keeping
  // only the hasher's small internal block and digest; never copy another whole plan image.
  const hasher = sha256.create();
  let digest: Uint8Array;
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024)
      hasher.update(bytes.subarray(offset, Math.min(bytes.byteLength, offset + 64 * 1024)));
    digest = hasher.digest();
  } finally {
    hasher.destroy();
  }
  return Promise.resolve({
    format: 'sqlite-health-v1',
    policy,
    sqliteVersion,
    imageByteLength: bytes.byteLength,
    sha256: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  });
}
