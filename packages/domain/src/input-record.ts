/** Plain runtime data only; typed form candidates must not acquire authority through extra fields. */
export function isInputRecord(
  value: unknown,
  allowed: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every(
    (key) =>
      typeof key === 'string' &&
      allowed.includes(key) &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'),
  );
}
