import { message as uiMessage } from '../messages';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { Modal } from './modal';

type Guard = (proceed: () => void) => void;

interface RegisteredGuard {
  readonly dirty: () => boolean;
  readonly guard: Guard;
}

interface NavigationGuardRegistry {
  register(entry: RegisteredGuard): () => void;
  /** Run `proceed` now, or after the first dirty editor's Save/Discard choice. */
  guard: Guard;
}

const NavigationGuardContext = createContext<NavigationGuardRegistry | null>(null);

/**
 * Scope for programmatic navigation (Go to date and similar) that must honor the unsaved-change
 * guard of whichever editor below it is dirty. Link clicks are intercepted by the guard itself.
 */
export function NavigationGuardProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const entries = useRef<RegisteredGuard[]>([]);
  const registry = useMemo<NavigationGuardRegistry>(
    () => ({
      register(entry) {
        entries.current = [...entries.current, entry];
        return () => {
          entries.current = entries.current.filter((candidate) => candidate !== entry);
        };
      },
      guard(proceed) {
        const dirty = entries.current.find((entry) => entry.dirty());
        if (dirty === undefined) proceed();
        else dirty.guard(proceed);
      },
    }),
    [],
  );
  return (
    <NavigationGuardContext.Provider value={registry}>{children}</NavigationGuardContext.Provider>
  );
}

/** Navigate in-app through the active unsaved-change guard, when one is in scope. */
export function useGuardedNavigate(): (to: string) => void {
  const navigate = useNavigate();
  const registry = useContext(NavigationGuardContext);
  return useCallback(
    (to: string) => {
      const go = (): void => void navigate(to);
      if (registry === null) go();
      else registry.guard(go);
    },
    [navigate, registry],
  );
}

/** After a failed Save the editor's own error and field must be reachable, so focus them. */
function focusFirstProblem(): void {
  const target =
    document.querySelector<HTMLElement>('[role="alert"][tabindex]') ??
    document.querySelector<HTMLElement>(
      'input[aria-invalid="true"], textarea[aria-invalid="true"], select[aria-invalid="true"]',
    );
  target?.focus();
}

/**
 * Leaving a dirty editor (link navigation, Go to date, or horizon change) offers Save, Discard, or
 * Continue editing. Browser unload uses the platform confirmation.
 */
export function useUnsavedGuard(
  dirty: boolean,
  save: () => Promise<boolean>,
): { readonly dialog: ReactNode; readonly guard: (proceed: () => void) => void } {
  const navigate = useNavigate();
  const registry = useContext(NavigationGuardContext);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (dirtyRef.current) event.preventDefault();
    };
    const intercept = (event: MouseEvent): void => {
      if (!dirtyRef.current || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(target instanceof HTMLAnchorElement) || target.target === '_blank') return;
      const url = new URL(target.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      event.stopPropagation();
      setPending(() => () => void navigate(`${url.pathname}${url.search}${url.hash}`));
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', intercept, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', intercept, true);
    };
  }, [navigate]);
  const guard = (proceed: () => void): void => {
    if (dirtyRef.current) setPending(() => proceed);
    else proceed();
  };
  const guardRef = useRef(guard);
  guardRef.current = guard;
  useEffect(
    () =>
      registry?.register({
        dirty: () => dirtyRef.current,
        guard: (proceed) => guardRef.current(proceed),
      }),
    [registry],
  );
  const dialog = (
    <Modal
      open={pending !== null}
      eyebrow={uiMessage('plan.unsaved-guard.2419')}
      title={uiMessage('plan.unsaved-guard.1887')}
      onClose={() => setPending(null)}
    >
      <p>{uiMessage('plan.unsaved-guard.1888')}</p>
      <div className="dialog-actions">
        <button type="button" data-autofocus onClick={() => setPending(null)}>
          {uiMessage('plan.unsaved-guard.1889')}
        </button>
        <button
          type="button"
          onClick={() => {
            const next = pending;
            dirtyRef.current = false;
            setPending(null);
            next?.();
          }}
        >
          {uiMessage('plan.unsaved-guard.1890')}
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={saving}
          onClick={() => {
            const next = pending;
            setSaving(true);
            void save()
              .then((saved) => {
                setPending(null);
                if (saved) {
                  dirtyRef.current = false;
                  next?.();
                } else {
                  // Stay on the page: close the dialog so the editor's error and field are
                  // reachable, then move focus there (after the dialog returns focus).
                  window.requestAnimationFrame(focusFirstProblem);
                }
              })
              .finally(() => setSaving(false));
          }}
        >
          {saving ? uiMessage('account.conflicts-page.133') : uiMessage('plan.unsaved-guard.1891')}
        </button>
      </div>
    </Modal>
  );
  return { dialog, guard };
}
