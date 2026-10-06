/**
 * Small shared pieces of the account UI: headings at a chosen level, the result message that
 * receives focus after a command, guarded reads, the online flag, and time display.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';

import { usePlanQuery, usePlanningOptional } from '../plan/planning-context';
import type { AccountResult, CountsByKind } from './account-service';
import { formatSyncTime } from './sync-text';

/** The HTML input-purpose values these forms use (WCAG 2.2 SC 1.3.5). */
export type InputPurpose = 'username' | 'email' | 'current-password' | 'new-password' | 'off';

export type HeadingLevel = 2 | 3 | 4;

/** A heading at a level chosen by where the content is shown (a page or a dialog). */
export function Heading({
  level,
  ...props
}: HTMLAttributes<HTMLHeadingElement> & {
  readonly level: HeadingLevel;
  readonly ref?: RefObject<HTMLHeadingElement | null>;
}): ReactNode {
  if (level === 2) return <h2 {...props} />;
  if (level === 3) return <h3 {...props} />;
  return <h4 {...props} />;
}

export const nextLevel = (level: HeadingLevel): HeadingLevel => (level === 2 ? 3 : 4);

/** Run a service call; an unexpected exception becomes a calm refusal with `message`. */
export async function attempt<Value>(
  operation: () => Promise<AccountResult<Value>>,
  message: string,
): Promise<AccountResult<Value>> {
  try {
    return await operation();
  } catch {
    return { ok: false, code: 'unexpected', message };
  }
}

/** A message with a key, so the same text shown twice is still a new message. */
export interface KeyedMessage {
  readonly text: string;
  readonly key: number;
}

/** The next keyed message after `current`. */
export const nextMessage = (current: KeyedMessage | null, text: string): KeyedMessage => ({
  text,
  key: (current?.key ?? 0) + 1,
});

/* ───────────────────────── Result messages ───────────────────────── */

export interface ResultMessage {
  readonly message: { readonly text: string; readonly key: number; readonly focus: boolean } | null;
  readonly ref: RefObject<HTMLParagraphElement | null>;
  /** Show a result; it receives focus unless `focus` is false. */
  show(text: string, options?: { readonly focus?: boolean }): void;
  clear(): void;
}

/** The latest command result. Each one replaces the last and, by default, receives focus. */
export function useResultMessage(): ResultMessage {
  const [message, setMessage] = useState<ResultMessage['message']>(null);
  const counter = useRef(0);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message?.focus === true) ref.current?.focus();
  }, [message]);
  const show = useCallback((text: string, options: { readonly focus?: boolean } = {}) => {
    counter.current += 1;
    setMessage({ text, key: counter.current, focus: options.focus ?? true });
  }, []);
  const clear = useCallback(() => setMessage(null), []);
  return { message, ref, show, clear };
}

/** The polite status region that shows a result. */
export function ResultRegion({ result }: { readonly result: ResultMessage }): ReactNode {
  return (
    <div role="status" className="account-status-region">
      {result.message !== null && (
        <p key={result.message.key} ref={result.ref} className="account-result" tabIndex={-1}>
          {result.message.text}
        </p>
      )}
    </div>
  );
}

/** Focus `ref` after each change of `trigger` (a counter above zero), once it has rendered. */
export function useFocusAfter(ref: RefObject<HTMLElement | null>, trigger: number): void {
  useEffect(() => {
    if (trigger > 0) ref.current?.focus();
  }, [trigger]);
}

/**
 * Like `useFocusAfter`, one frame later: a modal dialog that closes in the same update has closed
 * by then, so the page is no longer inert and its own focus return is done. Use it for a message
 * outside a dialog that the dialog's outcome brings, whose opener may be gone.
 */
export function useFocusAfterDialogs(ref: RefObject<HTMLElement | null>, trigger: number): void {
  useEffect(() => {
    if (trigger === 0) return;
    const frame = window.requestAnimationFrame(() => ref.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [trigger]);
}

/* ───────────────────────── Reads ───────────────────────── */

export type AccountReadState<Data> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: Data }
  | { readonly status: 'error' };

/**
 * One guarded read: the newest answer wins, an unmounted view ignores late answers, and a failed
 * read is an error state instead of an exception. Dependency changes re-read without a loading
 * flash; `retry` shows loading again.
 */
export function useAccountRead<Data>(
  load: () => Promise<Data>,
  dependencies: readonly unknown[],
): { readonly state: AccountReadState<Data>; readonly retry: () => void } {
  const [state, setState] = useState<AccountReadState<Data>>({ status: 'loading' });
  const loader = useRef(load);
  loader.current = load;
  const generation = useRef(0);
  const mounted = useRef(true);
  const read = useCallback(async (): Promise<void> => {
    const ticket = ++generation.current;
    try {
      const data = await loader.current();
      if (mounted.current && ticket === generation.current) setState({ status: 'ready', data });
    } catch {
      if (mounted.current && ticket === generation.current) setState({ status: 'error' });
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void read();
    return () => {
      mounted.current = false;
    };
  }, dependencies);
  const retry = useCallback(() => {
    setState({ status: 'loading' });
    void read();
  }, [read]);
  return { state, retry };
}

/** The browser's online flag, kept current. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/**
 * Format sync times in the planning zone and time format when the planning services are mounted,
 * and in the device's own otherwise.
 */
export function useTimeDisplay(): (iso: string | undefined) => string | null {
  const planning = usePlanningOptional();
  const { state } = usePlanQuery(
    () =>
      planning === null
        ? Promise.resolve(null)
        : planning.getCapacitySettings().then((settings) => settings.profile),
    [planning],
  );
  const profile = state.status === 'ready' ? state.data : null;
  return useCallback(
    (iso: string | undefined) =>
      iso === undefined
        ? null
        : formatSyncTime(
            iso,
            profile === null
              ? {}
              : { timeZone: profile.planningTimeZone, timeFormat: profile.timeFormat },
          ),
    [profile],
  );
}

/* ───────────────────────── Counts ───────────────────────── */

/** Record counts by kind, in the order given. */
export function CountsList({
  counts,
  label,
}: {
  readonly counts: CountsByKind;
  readonly label: string;
}): ReactNode {
  if (counts.kinds.length === 0) return null;
  return (
    <ul className="account-counts" aria-label={label}>
      {counts.kinds.map((kind) => (
        <li key={kind.label}>{`${kind.label}: ${String(kind.count)}`}</li>
      ))}
    </ul>
  );
}
