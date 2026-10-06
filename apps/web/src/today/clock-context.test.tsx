// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClockContext, useClock } from './clock-context';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Probe(): ReactNode {
  const now = useClock();
  return <p>{new Date(now()).toISOString()}</p>;
}

describe('ClockContext', () => {
  it('reads the browser clock by default', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-28T13:00:00.000Z') });
    render(<Probe />);
    expect(screen.getByText('2026-09-28T13:00:00.000Z')).toBeVisible();
  });

  it('reads an injected clock', () => {
    render(
      <ClockContext.Provider value={() => Date.parse('2026-12-31T23:59:00.000Z')}>
        <Probe />
      </ClockContext.Provider>,
    );
    expect(screen.getByText('2026-12-31T23:59:00.000Z')).toBeVisible();
  });
});
