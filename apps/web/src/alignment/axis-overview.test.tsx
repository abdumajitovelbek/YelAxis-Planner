// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AlignmentApplication, AxisSummary } from '@yelaxis/application';

import {
  alignmentTree,
  axisSummary,
  bounded,
  fakeAlignment,
  ids,
  installDialogPolyfill,
  receipt,
  unassignedView,
} from './__fixtures__/alignment-fake';
import { AxisOverviewPage } from './axis-overview';

beforeAll(installDialogPolyfill);
afterEach(() => cleanup());

const health = axisSummary();
const craft: AxisSummary = {
  id: ids.craft,
  localRevision: 1,
  title: 'Craft',
  color: 'violet',
  state: 'active',
  orderKey: '000002000000000',
  counts: { outcomes: 1, projects: 0, routines: 0 },
};
const oldAxis = axisSummary({
  id: ids.archivedAxis,
  title: 'Old studies',
  state: 'archived',
  counts: { outcomes: 0, projects: 0, routines: 0 },
});

function overviewAlignment(overrides: Partial<AlignmentApplication> = {}): AlignmentApplication {
  return fakeAlignment({
    listAxes: vi.fn((options?: { readonly includeArchived?: boolean }) =>
      Promise.resolve(
        options?.includeArchived === true
          ? bounded([health, craft, oldAxis])
          : bounded([health, craft]),
      ),
    ),
    listUnassigned: vi.fn(() => Promise.resolve(unassignedView())),
    ...overrides,
  });
}

function renderOverview(alignment: AlignmentApplication, path = '/axis') {
  return render(
    alignmentTree(alignment, <AxisOverviewPage />, {
      path,
      route: '/axis',
      notice: true,
      extraRoutes: <Route path="/axis/:axisId" element={<h1>Axis page</h1>} />,
    }),
  );
}

describe('Axis overview', () => {
  it('lists Axes in order with purpose and neutral counts', async () => {
    renderOverview(overviewAlignment());
    expect(screen.getByRole('heading', { level: 1, name: 'Axes' })).toBeVisible();
    const list = await screen.findByRole('list', { name: 'Axes' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'Health' })).toHaveAttribute(
      'href',
      `/axis/${ids.health}`,
    );
    expect(rows[0]).toHaveTextContent('Feel strong and rested through the year.');
    expect(rows[0]).toHaveTextContent('2 Outcomes · 1 Project · 1 Routine');
    expect(rows[1]).toHaveTextContent('1 Outcome · 0 Projects · 0 Routines');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Open alignment map' })).toHaveAttribute(
      'href',
      '/axis/alignment',
    );
  });

  it('shows each Axis icon, or its initial when it has none', async () => {
    renderOverview(
      overviewAlignment({
        listAxes: vi.fn(() => Promise.resolve(bounded([{ ...health, icon: 'standard' }, craft]))),
      }),
    );
    const list = await screen.findByRole('list', { name: 'Axes' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first?.querySelector('img[data-axis-icon="standard"]')).toHaveAttribute('alt', '');
    const fallback = second?.querySelector('[data-axis-icon="none"]');
    expect(fallback).toHaveTextContent('C');
    expect(fallback).toHaveAttribute('aria-hidden', 'true');
    // Decoration never changes the accessible names.
    expect(within(first as HTMLElement).getByRole('link', { name: 'Health' })).toBeVisible();
  });

  it('reorders Axes by keyboard with the persisted revision', async () => {
    const user = userEvent.setup();
    const reorder = vi.fn(() => Promise.resolve(receipt()));
    renderOverview(overviewAlignment({ reorder }));
    await screen.findByRole('list', { name: 'Axes' });
    expect(screen.getByRole('button', { name: 'Move Health up' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Move Craft down' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    screen.getByRole('button', { name: 'Move Craft up' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(reorder).toHaveBeenCalledWith({
        target: { kind: 'axis', id: ids.craft, revision: 1 },
        direction: 'up',
        scope: { container: 'axes' },
      }),
    );
    expect(await screen.findByText('Craft moved up.')).toBeInTheDocument();
  });

  it('shows archived Axes only on request, in the URL, without reordering them', async () => {
    const user = userEvent.setup();
    const listAxes = vi.fn((options?: { readonly includeArchived?: boolean }) =>
      Promise.resolve(
        options?.includeArchived === true
          ? bounded([health, craft, oldAxis])
          : bounded([health, craft]),
      ),
    );
    renderOverview(overviewAlignment({ listAxes }));
    await screen.findByRole('list', { name: 'Axes' });
    await user.click(screen.getByRole('checkbox', { name: 'Show archived Axes' }));
    expect(await screen.findByRole('link', { name: 'Old studies' })).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('/axis?archived=1');
    expect(listAxes).toHaveBeenLastCalledWith({ includeArchived: true });
    const row = screen.getByRole('link', { name: 'Old studies' }).closest('li') as HTMLElement;
    expect(within(row).getByText('Archived')).toBeVisible();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  it('opens with archived Axes from the URL', async () => {
    renderOverview(overviewAlignment(), '/axis?archived=1');
    expect(await screen.findByRole('link', { name: 'Old studies' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Show archived Axes' })).toBeChecked();
  });

  it('says calmly when there are no Axes yet', async () => {
    renderOverview(
      overviewAlignment({
        listAxes: vi.fn(() => Promise.resolve(bounded([]))),
        listUnassigned: vi.fn(() =>
          Promise.resolve(unassignedView({ outcomes: bounded([]), projects: bounded([]) })),
        ),
      }),
    );
    expect(await screen.findByText('No Axes yet.')).toBeVisible();
    expect(screen.getByText('Every Outcome and Project is in an Axis.')).toBeVisible();
  });

  it('lists Outcomes and Projects that are not in an Axis', async () => {
    const user = userEvent.setup();
    const reorder = vi.fn(() => Promise.resolve(receipt()));
    renderOverview(overviewAlignment({ reorder }));
    const section = await screen.findByRole('region', { name: 'Not in an Axis' });
    expect(
      within(within(section).getByRole('list', { name: 'Outcomes not in an Axis' })).getByRole(
        'link',
        { name: 'Finish the novel draft' },
      ),
    ).toHaveAttribute('href', `/outcomes/${ids.novel}`);
    expect(within(section).getByText('No progress measure')).toBeVisible();
    const projects = within(section).getByRole('list', { name: 'Projects not in an Axis' });
    expect(within(projects).getByText('Idea')).toBeVisible();
    expect(within(projects).queryByText('No next action yet.')).not.toBeInTheDocument();
    await user.click(
      within(section).getByRole('button', { name: 'Move Finish the novel draft down' }),
    );
    expect(reorder).not.toHaveBeenCalled();
  });

  it('creates an Axis and opens it with the confirmation and Undo', async () => {
    const user = userEvent.setup();
    const createAxis = vi.fn(() => Promise.resolve(receipt({ type: 'axis', id: ids.craft })));
    renderOverview(overviewAlignment({ createAxis }));
    await screen.findByRole('list', { name: 'Axes' });
    await user.click(screen.getByRole('button', { name: 'New Axis…' }));
    const dialog = screen.getByRole('dialog', { name: 'New Axis' });
    await user.type(within(dialog).getByLabelText('Title'), 'Family');
    await user.click(within(dialog).getByRole('button', { name: 'Create Axis' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Axis page' })).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent(`/axis/${ids.craft}`);
    expect(
      screen.getByText('Axis created.', { selector: '.navigation-notice span' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  it('recovers from a read error', async () => {
    const user = userEvent.setup();
    const listAxes = vi
      .fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(bounded([health]));
    renderOverview(overviewAlignment({ listAxes }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Health' })).toBeVisible();
  });
});
