// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  fakePlanning,
  installDialogPolyfill,
  occurrence,
  profile,
  receipt,
  renderTree,
  stretch,
  swim,
} from './__fixtures__/c1-planning-fake';
import { OccurrenceControls } from './occurrence-controls';

beforeAll(() => {
  installDialogPolyfill();
});

afterEach(() => cleanup());

const skipped = occurrence({
  occurrenceId: 'occ-read',
  routineId: 'routine-read',
  title: 'Read',
  day: '2026-10-01',
  timing: { kind: 'flexible' },
  state: 'skipped',
  revision: 2,
});

describe('OccurrenceControls compact', () => {
  it('keeps status, Complete, Skip, and Details, and leaves editing to Plan', async () => {
    const user = userEvent.setup();
    const completeOccurrence = vi.fn(() => Promise.resolve(receipt()));
    const skipOccurrence = vi.fn(() => Promise.resolve(receipt()));
    const planning = fakePlanning({ completeOccurrence, skipOccurrence });
    render(renderTree(planning, <OccurrenceControls compact entry={stretch} profile={profile} />));
    expect(screen.getByText('Planned')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Edit this occurrence/ })).toBeNull();
    const details = screen.getByRole('link', { name: 'Details Stretch' });
    expect(details).toHaveAttribute('href', '/plan/routines/routine-stretch');
    await user.click(screen.getByRole('button', { name: 'Complete Stretch' }));
    expect(completeOccurrence).toHaveBeenCalledWith({
      occurrence: { routineId: 'routine-stretch', generation: 1, period: stretch.ref.period },
    });
    await user.click(screen.getByRole('button', { name: 'Skip Stretch' }));
    expect(skipOccurrence).toHaveBeenCalledOnce();
  });

  it('shows a skipped occurrence as a neutral state with Reopen', () => {
    render(renderTree(fakePlanning(), <OccurrenceControls compact entry={skipped} />));
    expect(screen.getByText('Skipped')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reopen Read' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/missed|streak|failed/iu);
  });

  it('offers Log one for a weekly count', () => {
    render(renderTree(fakePlanning(), <OccurrenceControls compact entry={swim} />));
    expect(screen.getByText('1 of 2 this week')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Log one Swim' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Details Swim' })).toBeVisible();
  });

  it('reads “Details” without planning services too', () => {
    render(
      <MemoryRouter>
        <OccurrenceControls compact entry={stretch} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Details for Stretch' })).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps the planning controls when not compact', () => {
    render(renderTree(fakePlanning(), <OccurrenceControls entry={stretch} profile={profile} />));
    expect(screen.getByRole('button', { name: 'Edit this occurrence… Stretch' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Routine details Stretch' })).toBeVisible();
    cleanup();
    render(
      <MemoryRouter>
        <OccurrenceControls entry={stretch} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Routine details for Stretch' })).toBeVisible();
  });
});
