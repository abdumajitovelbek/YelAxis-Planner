/**
 * Retry backoff for transient sync failures: exponential from 5 seconds, capped at
 * 15 minutes, with ±20% jitter from an injected random source. The delay never exceeds the cap.
 */
export const syncBackoffPolicy = Object.freeze({
  initialMs: 5_000,
  maximumMs: 15 * 60_000,
  jitter: 0.2,
});

/**
 * The wait before attempt `failures + 1`, after `failures` consecutive transient failures (≥ 1).
 * `random` returns a value in [0, 1).
 */
export function syncBackoffDelay(failures: number, random: () => number): number {
  const exponent = Math.max(0, Math.min(Math.floor(failures) - 1, 30));
  const nominal = Math.min(
    syncBackoffPolicy.initialMs * 2 ** exponent,
    syncBackoffPolicy.maximumMs,
  );
  const sample = Math.min(Math.max(random(), 0), 1);
  const factor = 1 - syncBackoffPolicy.jitter + 2 * syncBackoffPolicy.jitter * sample;
  return Math.round(Math.min(nominal * factor, syncBackoffPolicy.maximumMs));
}
