// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { TimedEntry } from '@yelaxis/application';

import {
  dentist,
  fakePlanning,
  profile,
  renderTree,
  report,
} from './__fixtures__/c1-planning-fake';
import { useCommandRunner } from './planning-context';
import { TimedEntryCard, buildConflictIndex } from './scheduling-dialogs';
import { DayTimeline } from './timeline';

afterEach(() => cleanup());

const renderTimeline = (
  entries: readonly TimedEntry[],
  now?: { readonly minute: number; readonly label: string },
) =>
  render(
    <DayTimeline
      date="2026-09-29"
      entries={entries}
      label="Timed plan for Tuesday"
      profile={profile}
      {...(now === undefined ? {} : { now })}
      renderEntry={(entry) => <p>{entry.title}</p>}
    />,
  );

describe('DayTimeline current time', () => {
  it('draws a decorative marker at the minute and says the time in text', () => {
    renderTimeline([dentist], { minute: 9 * 60 + 40, label: 'Now 09:40' });
    expect(screen.getByText('Now 09:40')).toBeVisible();
    const marker = screen.getByTestId('timeline-now');
    expect(marker).toHaveAttribute('aria-hidden', 'true');
    expect(marker.tagName).toBe('LI');
    // Hours start at 06:00 (row 1); 09:40 falls in the 09:30 quarter, two thirds of the way in.
    expect(marker.style.gridRow).toBe('15 / span 1');
    const line = marker.querySelector<HTMLElement>('.timeline-now-line');
    expect(Number.parseFloat(line?.style.top ?? '')).toBeCloseTo(66.67, 1);
    // The marker is not an item of the timeline for assistive technology.
    const list = screen.getByRole('list', { name: 'Timed plan for Tuesday' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows the early hours while now is before 06:00', () => {
    renderTimeline([dentist], { minute: 5, label: 'Now 00:05' });
    expect(screen.getByText('Showing from 00:00 so the current time is in view.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show hours before 06:00' })).toBeNull();
    expect(screen.getByTestId('timeline-now').style.gridRow).toBe('1 / span 1');
  });

  it('keeps the planning timeline unchanged without `now`', async () => {
    const user = userEvent.setup();
    renderTimeline([dentist, report]);
    expect(screen.queryByTestId('timeline-now')).toBeNull();
    expect(screen.queryByText(/^Now /)).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show hours before 06:00' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide hours before 06:00' })).toBeVisible();
  });

  it('keeps the early-start note when something starts before 06:00', () => {
    renderTimeline([{ ...dentist, localStart: '05:00' as TimedEntry['localStart'] }], {
      minute: 600,
      label: 'Now 10:00',
    });
    expect(screen.getByText('Showing from 00:00 because something starts early.')).toBeVisible();
    expect(screen.getByTestId('timeline-now').style.gridRow).toBe('41 / span 1');
  });
});

function Card({ withExtra }: { readonly withExtra: boolean }) {
  const runner = useCommandRunner();
  return (
    <TimedEntryCard
      entry={report}
      date="2026-09-29"
      conflictIndex={buildConflictIndex([])}
      onRequest={() => undefined}
      profile={profile}
      runner={runner}
      {...(withExtra
        ? {
            extraOptions: (entry: TimedEntry) => (
              <button type="button">Extra for {entry.title}</button>
            ),
          }
        : {})}
    />
  );
}

describe('TimedEntryCard extra options', () => {
  it('adds a view’s own choices inside the Options disclosure', () => {
    render(renderTree(fakePlanning(), <Card withExtra />));
    const options = screen.getByText('Options').closest('details');
    expect(options).not.toBeNull();
    expect(
      within(options as HTMLElement).getByRole('button', { name: 'Extra for Write report' }),
    ).toBeInTheDocument();
  });

  it('renders the planning controls only without them', () => {
    render(renderTree(fakePlanning(), <Card withExtra={false} />));
    expect(screen.queryByRole('button', { name: /Extra for/ })).toBeNull();
    expect(document.querySelector('.entry-extra-options')).toBeNull();
    expect(screen.getByRole('button', { name: 'Complete… Write report' })).toBeInTheDocument();
  });
});
