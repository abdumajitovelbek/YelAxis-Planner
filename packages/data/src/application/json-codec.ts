import { DataAdapterError } from './errors';

export type JsonValue =
  boolean | null | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function encodeJson(value: unknown): string {
  assertJsonValue(value, new Set<object>());
  try {
    return JSON.stringify(value);
  } catch {
    throw new DataAdapterError('invalid_json_payload');
  }
}

export function decodeJson(value: string): JsonValue {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new DataAdapterError('invalid_persisted_record');
  }
  assertJsonValue(decoded, new Set<object>());
  return decoded;
}

function assertJsonValue(value: unknown, ancestors: Set<object>): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }

  if (typeof value !== 'object') throw new DataAdapterError('invalid_json_payload');
  if (ancestors.has(value)) throw new DataAdapterError('invalid_json_payload');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertJsonValue(item, ancestors);
      return;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DataAdapterError('invalid_json_payload');
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertJsonValue(item, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}
