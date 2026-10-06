// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFocusRescue } from './timeline';

/* Animation frames are queued by hand so each test decides when a frame runs relative to the
   re-query, as a slower browser can. */
let frames = new Map<number, FrameRequestCallback>();
let lastFrame = 0;

function runFrame(): void {
  const due = [...frames.values()];
  frames = new Map();
  act(() => {
    for (const callback of due) callback(0);
  });
}

beforeEach(() => {
  frames = new Map();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    lastFrame += 1;
    frames.set(lastFrame, callback);
    return lastFrame;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Data {
  readonly linked: boolean;
}

function View({ busy, data }: { readonly busy: boolean; readonly data: Data }): ReactNode {
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusRescue(heading, { busy }, data);
  return (
    <>
      <h2 ref={heading} tabIndex={-1}>
        Selected
      </h2>
      {data.linked && <button type="button">Unlink…</button>}
      <button type="button">Other</button>
    </>
  );
}

describe('useFocusRescue', () => {
  it('rescues focus when the re-queried view removes the control focus returned to', () => {
    const shown = { linked: true };
    const view = render(<View busy={false} data={shown} />);
    const unlink = screen.getByRole('button', { name: 'Unlink…' });
    unlink.focus();
    view.rerender(<View busy data={shown} />);
    // The command finished and a closing dialog returned focus to its opener; the view still shows
    // the data from before the command.
    view.rerender(<View busy={false} data={shown} />);
    runFrame();
    expect(unlink).toHaveFocus();
    // The re-query removes the opener, so focus would be left on the page body.
    view.rerender(<View busy={false} data={{ linked: false }} />);
    runFrame();
    expect(screen.getByRole('heading', { name: 'Selected' })).toHaveFocus();
  });

  it('stands down once focus survives the re-queried view', () => {
    const shown = { linked: true };
    const view = render(<View busy={false} data={shown} />);
    const other = screen.getByRole('button', { name: 'Other' });
    other.focus();
    view.rerender(<View busy data={shown} />);
    view.rerender(<View busy={false} data={shown} />);
    runFrame();
    view.rerender(<View busy={false} data={{ linked: true }} />);
    runFrame();
    expect(other).toHaveFocus();
    // A later refresh without a command never moves focus, even from the page body.
    other.blur();
    view.rerender(<View busy={false} data={{ linked: false }} />);
    runFrame();
    expect(document.body).toHaveFocus();
  });
});
