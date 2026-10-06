import { useLayoutEffect } from 'react';
import { NavigationType, useLocation, useNavigationType } from 'react-router-dom';

const scrollKey = (key: string): string => `yelaxis:plan:scroll:${key}`;

/**
 * Remember the window scroll per history entry and restore it on Back/Forward so the previous
 * horizon, date, and position come back together. New navigations start at the top.
 */
export function useScrollMemory(): void {
  const location = useLocation();
  const navigationType = useNavigationType();
  useLayoutEffect(() => {
    const key = scrollKey(location.key);
    let saveFrame = 0;
    let restoreFrame = 0;
    let restoring = false;
    let pendingPosition: number | null = null;
    const flush = (): void => {
      if (pendingPosition === null) return;
      try {
        window.sessionStorage.setItem(key, String(pendingPosition));
      } catch {
        // Scroll memory is a convenience only.
      }
      pendingPosition = null;
      saveFrame = 0;
    };
    const save = (): void => {
      if (restoring) return;
      // Capture before a route commit can replace the content and clamp the window to the top.
      pendingPosition = Math.round(window.scrollY);
      window.cancelAnimationFrame(saveFrame);
      saveFrame = window.requestAnimationFrame(flush);
    };
    const stopRestoring = (): void => {
      restoring = false;
      window.cancelAnimationFrame(restoreFrame);
    };
    if (navigationType === NavigationType.Pop) {
      let saved = Number.NaN;
      try {
        saved = Number(window.sessionStorage.getItem(key));
      } catch {
        saved = Number.NaN;
      }
      if (Number.isFinite(saved) && saved > 0) {
        restoring = true;
        const started = performance.now();
        const attempt = (): void => {
          if (!restoring) return;
          window.scrollTo(0, saved);
          if (Math.abs(window.scrollY - saved) <= 1 || performance.now() - started > 2000)
            restoring = false;
          else restoreFrame = window.requestAnimationFrame(attempt);
        };
        attempt();
      }
    } else {
      window.scrollTo(0, 0);
    }
    window.addEventListener('scroll', save, { passive: true });
    window.addEventListener('wheel', stopRestoring, { passive: true });
    window.addEventListener('keydown', stopRestoring);
    window.addEventListener('pointerdown', stopRestoring);
    return () => {
      stopRestoring();
      window.cancelAnimationFrame(saveFrame);
      // Navigation can beat the debounce frame; keep the captured old entry's position.
      flush();
      window.removeEventListener('scroll', save);
      window.removeEventListener('wheel', stopRestoring);
      window.removeEventListener('keydown', stopRestoring);
      window.removeEventListener('pointerdown', stopRestoring);
    };
  }, [location.key, navigationType]);
}
