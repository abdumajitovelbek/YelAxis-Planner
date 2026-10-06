/** Small runtime shape checks at application boundaries; domain policies remain authoritative. */
export type InputCheck = (value: unknown) => boolean;

export const inputString: InputCheck = (value) => typeof value === 'string';
export const inputBoolean: InputCheck = (value) => typeof value === 'boolean';
export const inputInteger: InputCheck = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value);
export const inputRevision: InputCheck = (value) => inputInteger(value) && (value as number) >= 1;
export const optionalInput =
  (check: InputCheck): InputCheck =>
  (value) =>
    value === undefined || check(value);
export const nullableInput =
  (check: InputCheck): InputCheck =>
  (value) =>
    value === null || check(value);
export const inputChoice =
  (...choices: readonly unknown[]): InputCheck =>
  (value) =>
    choices.includes(value);
export const inputList =
  (check: InputCheck): InputCheck =>
  (value) =>
    Array.isArray(value) && value.every(check);

export function isInputRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Own plain-data fields only: no prototype payload, getters, symbols or unrecognized authority. */
export const inputObject =
  (fields: Readonly<Record<string, InputCheck>>): InputCheck =>
  (value) => {
    if (!isInputRecord(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !Object.hasOwn(fields, key))) return false;
    if (
      keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))
    )
      return false;
    return Object.entries(fields).every(([key, check]) =>
      check(Object.hasOwn(value, key) ? value[key] : undefined),
    );
  };

export const inputUnion =
  (...checks: readonly InputCheck[]): InputCheck =>
  (value) =>
    checks.some((check) => check(value));

export function validInputArguments(
  args: readonly unknown[],
  checks: readonly InputCheck[],
): boolean {
  return args.length <= checks.length && checks.every((check, index) => check(args[index]));
}

/** Reject before any identity/query/transaction work. No values are logged or copied into errors. */
export function guardInputMethods<T extends object>(
  target: T,
  contracts: Readonly<Partial<Record<keyof T, readonly InputCheck[]>>>,
): T {
  const output = { ...target };
  for (const key of Object.keys(contracts) as (keyof T)[]) {
    const checks = contracts[key];
    const method = target[key];
    if (checks === undefined || typeof method !== 'function')
      throw new Error('Invalid command contract inventory.');
    output[key] = ((...args: readonly unknown[]) => {
      if (!validInputArguments(args, checks))
        return Promise.resolve({
          ok: false,
          error: {
            code: 'domain_rejected',
            domainError: {
              code: 'invalid_value',
              message: 'Check the information and try again. Nothing was changed.',
              details: { reason: 'input_shape' },
            },
          },
        });
      return (method as (...values: readonly unknown[]) => unknown).apply(target, [...args]);
    }) as T[keyof T];
  }
  return output;
}
