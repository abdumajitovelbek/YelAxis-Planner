import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireDatabaseLock } from './database-lock';

type PendingLock = {
  readonly name: string;
  readonly callback: (lock: Lock | null) => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
};

/** Models the native exclusive queue and cancellation without releasing another owner's lock. */
class TestLocks {
  readonly pending: PendingLock[] = [];
  held = false;
  grants = 0;
  readonly request = vi.fn(
    (
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => Promise<void>,
    ): Promise<void> =>
      new Promise((resolve, reject) => {
        const signal = options.signal;
        if (signal === undefined) throw new Error('A bounded request needs an AbortSignal.');
        const pending: PendingLock = {
          name,
          callback,
          resolve,
          reject,
          signal,
          abort: () => {
            const index = this.pending.indexOf(pending);
            if (index >= 0) this.pending.splice(index, 1);
            reject(new DOMException('Lock request aborted', 'AbortError'));
          },
        };
        signal.addEventListener('abort', pending.abort, { once: true });
        this.pending.push(pending);
        this.grant();
      }),
  );

  get manager() {
    return { request: this.request };
  }

  grant(): void {
    if (this.held) return;
    const pending = this.pending.shift();
    if (pending === undefined) return;
    this.held = true;
    this.grants += 1;
    pending.signal.removeEventListener('abort', pending.abort);
    void Promise.resolve()
      .then(() => pending.callback({ name: pending.name, mode: 'exclusive' }))
      .then(pending.resolve, pending.reject)
      .finally(() => {
        this.held = false;
        this.grant();
      });
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('browser database lock acquisition', () => {
  it('holds an exclusive named lock until the owner releases it', async () => {
    const locks = new TestLocks();
    const release = await acquireDatabaseLock(locks.manager, '/local.sqlite3');

    expect(locks.request.mock.calls[0]?.[0]).toBe('yelaxis-database:/local.sqlite3');
    expect(locks.request.mock.calls[0]?.[1]).toMatchObject({ mode: 'exclusive' });
    expect(locks.request.mock.calls[0]?.[1]).not.toHaveProperty('steal');
    expect(locks.held).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    release();
    await vi.runAllTimersAsync();
    expect(locks.held).toBe(false);
  });

  it('waits for a retiring worker to release its lock, then acquires without stealing', async () => {
    const locks = new TestLocks();
    locks.held = true;
    const opening = acquireDatabaseLock(locks.manager, '/local.sqlite3');
    await vi.advanceTimersByTimeAsync(80);
    expect(locks.grants).toBe(0);
    locks.held = false;
    locks.grant();

    const release = await opening;
    expect(locks.grants).toBe(1);
    expect(locks.held).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    release();
    await vi.runAllTimersAsync();
    expect(locks.held).toBe(false);
  });

  it('fails closed after 1000ms for an active tab and cannot acquire later', async () => {
    const locks = new TestLocks();
    locks.held = true;
    const result = acquireDatabaseLock(locks.manager, '/local.sqlite3').catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(locks.pending).toHaveLength(1);
    expect(locks.held).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toMatchObject({
      code: 'database_busy',
      message: 'The plan is already open in another tab.',
    });
    expect(locks.held).toBe(true);
    expect(locks.pending).toHaveLength(0);
    expect(locks.grants).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    locks.held = false;
    locks.grant();
    await vi.runAllTimersAsync();
    expect(locks.grants).toBe(0);
  });

  it('preserves a lock service error and clears its timer', async () => {
    const failure = new DOMException('Lock service refused the request', 'SecurityError');
    const locks = { request: vi.fn().mockRejectedValue(failure) };

    await expect(acquireDatabaseLock(locks, '/local.sqlite3')).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retain a grant whose callback arrives after the timeout', async () => {
    let grant: ((lock: Lock | null) => Promise<void>) | undefined;
    const locks = {
      request: vi.fn(
        (
          _name: string,
          options: LockOptions,
          callback: (lock: Lock | null) => Promise<void>,
        ): Promise<void> => {
          grant = callback;
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () =>
              reject(new DOMException('Lock request aborted', 'AbortError')),
            );
          });
        },
      ),
    };
    const result = acquireDatabaseLock(locks, '/local.sqlite3').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ code: 'database_busy' });
    // Native grant and timer tasks can race: a stale grant must return without holding the lock.
    await expect(
      grant?.({ name: 'yelaxis-database:/local.sqlite3', mode: 'exclusive' }),
    ).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets failed startup cleanup release ownership before another opening', async () => {
    const locks = new TestLocks();
    const release = await acquireDatabaseLock(locks.manager, '/local.sqlite3');
    const nextOpening = acquireDatabaseLock(locks.manager, '/local.sqlite3');
    expect(locks.pending).toHaveLength(1);
    // The worker calls the same release callback from close() if later storage startup fails.
    release();
    await vi.advanceTimersByTimeAsync(0);

    const releaseNext = await nextOpening;
    expect(locks.grants).toBe(2);
    expect(locks.held).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    releaseNext();
    await vi.runAllTimersAsync();
    expect(locks.held).toBe(false);
  });
});
