// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useScrollMemory } from './scroll-memory';

let position = 0;
let sequence = 0;
const frames = new Map<number, FrameRequestCallback>();
beforeEach(() => {
  window.sessionStorage.clear();
  position = 0;
  sequence = 0;
  frames.clear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++sequence;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => position);
  vi.stubGlobal('scrollTo', (_x: number, y: number) => {
    position = y;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Probe() {
  useScrollMemory();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <p data-testid="path">{location.pathname}</p>
      <Link to="/week">Open Week</Link>
      <button type="button" onClick={() => void navigate(-1)}>
        Back
      </button>
    </>
  );
}
function open() {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/month', key: 'month-entry' }]}>
      <Probe />
    </MemoryRouter>,
  );
}

describe('scroll memory around route commits', () => {
  it('flushes a captured position when navigation precedes the scheduled save frame', () => {
    open();
    act(() => {
      position = 640;
      window.dispatchEvent(new Event('scroll'));
    });
    expect(window.sessionStorage.getItem('yelaxis:plan:scroll:month-entry')).toBeNull();
    expect(frames.size).toBe(1);
    fireEvent.click(screen.getByRole('link', { name: 'Open Week' }));
    expect(screen.getByTestId('path')).toHaveTextContent('/week');
    expect(position).toBe(0);
    expect(window.sessionStorage.getItem('yelaxis:plan:scroll:month-entry')).toBe('640');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('path')).toHaveTextContent('/month');
    expect(position).toBe(640);
  });
  it('saves the scroll-event snapshot even if route layout clamps the window before RAF runs', () => {
    open();
    act(() => {
      position = 640;
      window.dispatchEvent(new Event('scroll'));
    });
    const pending = [...frames.values()][0];
    act(() => {
      position = 0;
      pending?.(performance.now());
    });
    expect(window.sessionStorage.getItem('yelaxis:plan:scroll:month-entry')).toBe('640');
  });
});
