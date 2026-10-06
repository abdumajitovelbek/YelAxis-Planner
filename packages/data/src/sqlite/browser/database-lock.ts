const lockAcquisitionTimeoutMs = 1000;

type DatabaseLocks = {
  request(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<void>,
  ): Promise<void>;
};

/**
 * A reload can start its worker before the previous worker's lock has been released. Queue a
 * bounded exclusive request so that worker can finish retiring; a genuinely active tab still
 * fails closed. Aborting removes the queued request, so it cannot acquire ownership later.
 */
export async function acquireDatabaseLock(locks: DatabaseLocks, name: string): Promise<() => void> {
  const controller = new AbortController();
  let timedOut = false;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, lockAcquisitionTimeoutMs);

  try {
    return await new Promise<() => void>((resolve, reject) => {
      void locks
        .request(
          `yelaxis-database:${name}`,
          { mode: 'exclusive', signal: controller.signal },
          async (lock) => {
            if (timedOut || lock === null) {
              reject(databaseBusy());
              return;
            }
            clearTimeout(timeout);
            resolve(release);
            await held;
          },
        )
        .catch((error: unknown) =>
          reject(
            timedOut
              ? databaseBusy()
              : error instanceof Error
                ? error
                : new Error('The browser lock request failed.', { cause: error }),
          ),
        );
    });
  } finally {
    clearTimeout(timeout);
  }
}

function databaseBusy(): Error & { readonly code: 'database_busy' } {
  return Object.assign(new Error('The plan is already open in another tab.'), {
    code: 'database_busy' as const,
  });
}
