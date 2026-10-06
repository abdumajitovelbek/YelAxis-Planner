import { useState } from 'react';

/** Presentation preferences are optional; denied storage must never prevent opening a plan. */
export function useStoredPreference<Value extends string>(
  key: string,
  fallback: Value,
  choices: readonly Value[],
): readonly [Value, (value: Value) => void] {
  const [value, setValue] = useState<Value>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return choices.find((choice) => choice === stored) ?? fallback;
    } catch {
      return fallback;
    }
  });
  return [
    value,
    (next) => {
      if (!choices.includes(next)) return;
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Keep this session's choice when browser persistence is unavailable.
      }
    },
  ];
}
