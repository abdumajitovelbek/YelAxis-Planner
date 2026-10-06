// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef, type ReactNode, type RefObject } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDialogPolyfill } from './__fixtures__/c1-planning-fake';
import { Modal } from './modal';
import { useDialogAutofocus as useFormDialogAutofocus } from './routine-form';
import { useDialogAutofocus } from './timeline';

/* Animation frames are queued by hand so a test can act between two frames, as a fast keyboard
   user can when a browser delays frames. */
let frames = new Map<number, FrameRequestCallback>();
let lastFrame = 0;

/** Run the frames queued so far; frames they queue wait for the next call. */
function runFrame(): void {
  const due = [...frames.values()];
  frames = new Map();
  act(() => {
    for (const callback of due) callback(0);
  });
}

beforeAll(installDialogPolyfill);

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

function Choice({ withHook }: { readonly withHook: boolean }): ReactNode {
  const container = useRef<HTMLDivElement>(null);
  return (
    <div ref={container} className="dialog-actions">
      {withHook && <Autofocus container={container} />}
      <button type="button" data-autofocus>
        Keep link
      </button>
      <button type="button">Unlink</button>
    </div>
  );
}

function Autofocus({
  container,
}: {
  readonly container: RefObject<HTMLDivElement | null>;
}): ReactNode {
  useDialogAutofocus(container);
  return null;
}

function FormBody(): ReactNode {
  const form = useFormDialogAutofocus();
  return (
    <form ref={form}>
      <label>
        Title
        <input data-autofocus />
      </label>
    </form>
  );
}

describe('dialog autofocus retries', () => {
  it('keeps focus on a button the person reached before the next frame', () => {
    render(
      <Modal open title="Unlink?" onClose={() => undefined}>
        <Choice withHook={false} />
      </Modal>,
    );
    expect(screen.getByRole('button', { name: 'Keep link' })).toHaveFocus();
    const unlink = screen.getByRole('button', { name: 'Unlink' });
    unlink.focus();
    runFrame();
    expect(unlink).toHaveFocus();
  });

  it('still moves focus to content that appears after opening while focus has not moved', () => {
    const view = render(
      <Modal open title="Schedule" onClose={() => undefined}>
        <p>Loading…</p>
      </Modal>,
    );
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    view.rerender(
      <Modal open title="Schedule" onClose={() => undefined}>
        <label>
          Duration
          <input />
        </label>
      </Modal>,
    );
    runFrame();
    expect(screen.getByRole('textbox', { name: 'Duration' })).toHaveFocus();
  });

  it('never pulls focus back from a button in the later dialog-body retry', () => {
    render(
      <Modal open title="Unlink?" onClose={() => undefined}>
        <Choice withHook />
      </Modal>,
    );
    runFrame();
    const unlink = screen.getByRole('button', { name: 'Unlink' });
    unlink.focus();
    runFrame();
    expect(unlink).toHaveFocus();
  });

  it('never pulls focus back into a form once the person moved to Close', () => {
    render(
      <Modal open title="New routine" onClose={() => undefined}>
        <FormBody />
      </Modal>,
    );
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
    runFrame();
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    runFrame();
    expect(close).toHaveFocus();
  });
});
