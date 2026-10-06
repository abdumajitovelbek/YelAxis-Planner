// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AlignmentApplication, PlanningApplication } from '@yelaxis/application';
import type { Instant } from '@yelaxis/domain';

import { monthlyPeriod, reviewId } from '../review/__fixtures__/review-fake';

import {
  alignmentPlanning,
  alignmentTree,
  archiveImpact,
  axisDetail,
  axisSummary,
  bounded,
  deleteImpact,
  fakeAlignment,
  ids,
  installDialogPolyfill,
  outcomeItem,
  projectItem,
  receipt,
} from './__fixtures__/alignment-fake';
import { AxisDetailPage } from './axis-detail';

beforeAll(installDialogPolyfill);
afterEach(() => cleanup());

const forbidden = /score|streak|\bAI\b|aligned \d+%/iu;

function renderAxis(
  alignment: AlignmentApplication,
  options: { readonly path?: string; readonly planning?: PlanningApplication } = {},
) {
  return render(
    alignmentTree(alignment, <AxisDetailPage />, {
      path: options.path ?? `/axis/${ids.health}`,
      route: '/axis/:axisId',
      notice: true,
      ...(options.planning === undefined ? {} : { planning: options.planning }),
      extraRoutes: (
        <>
          <Route path="/axis" element={<h1>Axes</h1>} />
          <Route path="/outcomes/:outcomeId" element={<h1>Outcome page</h1>} />
        </>
      ),
    }),
  );
}

describe('Axis detail', () => {
  it('shows the Axis, its current members, and neutral words only', async () => {
    const getAxis = vi.fn(() => Promise.resolve(axisDetail()));
    renderAxis(fakeAlignment({ getAxis }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
    expect(getAxis).toHaveBeenCalledWith(ids.health, { includeFinished: false });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Axis · Active')).toBeVisible();
    expect(screen.getByRole('link', { name: '← Axes' })).toHaveAttribute('href', '/axis');
    expect(screen.getByText('Feel strong and rested through the year.')).toBeVisible();
    expect(screen.getByText('Emerald')).toBeVisible();
    expect(screen.getByText('Icon').closest('div')).toHaveTextContent('HNo icon');
    expect(screen.getByText('In this Axis now').closest('div')).toHaveTextContent(
      '2 Outcomes · 1 Project · 1 Routine',
    );

    const outcomes = screen.getByRole('list', { name: 'Outcomes in Health' });
    const [first, second] = within(outcomes).getAllByRole('listitem');
    expect(
      within(first as HTMLElement).getByRole('link', { name: 'Run a half marathon' }),
    ).toHaveAttribute('href', `/outcomes/${ids.halfMarathon}`);
    expect(first).toHaveTextContent('1 of 2 milestones completed · 1 canceled');
    expect(second).toHaveTextContent('Paused');
    expect(second).toHaveTextContent('40% (set manually)');

    const projects = screen.getByRole('list', { name: 'Projects in Health' });
    const [active, idea] = within(projects).getAllByRole('listitem');
    expect(active).toHaveTextContent('No next action yet.');
    expect(idea).toHaveTextContent('Idea');
    expect(idea).not.toHaveTextContent('next action');

    expect(
      within(screen.getByRole('list', { name: 'Routines in Health' })).getByRole('link', {
        name: 'Morning stretch',
      }),
    ).toHaveAttribute('href', `/plan/routines/${ids.stretch}`);
    expect(screen.getByRole('region', { name: 'Recent review note' })).toHaveTextContent(
      'No review notes yet.',
    );
    expect(screen.getByRole('region', { name: 'History' })).toHaveTextContent('Details edited');
    expect(screen.getByRole('link', { name: 'Center in alignment map' })).toHaveAttribute(
      'href',
      `/axis/alignment?focus=axis:${ids.health}`,
    );
    expect(document.body.textContent).not.toMatch(forbidden);
    // Permanent deletion is the last section.
    const sections = document.querySelectorAll('section.axis-detail > section');
    expect(sections[sections.length - 1]).toHaveClass('danger-zone');
  });

  it('shows the most recent review note with the review it came from', async () => {
    renderAxis(
      fakeAlignment({
        getAxis: () =>
          Promise.resolve(
            axisDetail({
              reviewNote: {
                text: 'Morning walks helped.\nSleep too.',
                reviewId: reviewId(501),
                reviewType: 'monthly',
                period: monthlyPeriod,
                completedAt: '2026-09-30T19:00:00.000Z' as Instant,
              },
            }),
          ),
      }),
    );
    const region = await screen.findByRole('region', { name: 'Recent review note' });
    expect(within(region).getByText(/^Morning walks helped\./u)).toBeVisible();
    expect(region).toHaveTextContent('From the monthly review of September 2026');
    expect(region).not.toHaveTextContent('No review notes yet.');
    expect(within(region).getByRole('link', { name: 'Open this review' })).toHaveAttribute(
      'href',
      '/review/monthly/2026-09',
    );
  });

  it('names the next action of an active Project', async () => {
    renderAxis(
      fakeAlignment({
        getAxis: () =>
          Promise.resolve(
            axisDetail({
              projects: bounded([
                projectItem({
                  nextAction: {
                    status: 'present',
                    action: { id: ids.longRun, title: 'Long run', state: 'planned' },
                  },
                }),
              ]),
            }),
          ),
      }),
    );
    const projects = await screen.findByRole('list', { name: 'Projects in Health' });
    expect(within(projects).getByText(/Next action:/u)).toBeVisible();
    expect(within(projects).getByRole('link', { name: 'Long run' })).toHaveAttribute(
      'href',
      `/actions/${ids.longRun}`,
    );
    expect(within(projects).queryByText('No next action yet.')).not.toBeInTheDocument();
  });

  it('shows finished members on request without leaving the page', async () => {
    const user = userEvent.setup();
    const getAxis = vi.fn((_id: string, options?: { readonly includeFinished?: boolean }) =>
      Promise.resolve(
        options?.includeFinished === true
          ? axisDetail({
              outcomes: bounded([
                outcomeItem(),
                outcomeItem({ id: ids.sleep, title: 'Walk the coast path', state: 'achieved' }),
              ]),
            })
          : axisDetail(),
      ),
    );
    renderAxis(fakeAlignment({ getAxis }));
    const toggle = await screen.findByRole('checkbox', {
      name: 'Show finished Outcomes and Projects',
    });
    await user.click(toggle);
    expect(await screen.findByRole('link', { name: 'Walk the coast path' })).toBeVisible();
    expect(getAxis).toHaveBeenLastCalledWith(ids.health, { includeFinished: true });
    expect(
      screen.getByRole('checkbox', { name: 'Show finished Outcomes and Projects' }),
    ).toHaveFocus();
    expect(screen.getByText('Achieved')).toBeVisible();
  });

  it('reorders Outcomes within the Axis', async () => {
    const user = userEvent.setup();
    const reorder = vi.fn(() => Promise.resolve(receipt()));
    renderAxis(fakeAlignment({ getAxis: () => Promise.resolve(axisDetail()), reorder }));
    await screen.findByRole('list', { name: 'Outcomes in Health' });
    await user.click(screen.getByRole('button', { name: 'Move Sleep eight hours up' }));
    await waitFor(() =>
      expect(reorder).toHaveBeenCalledWith({
        target: { kind: 'outcome', id: ids.sleep, revision: 2 },
        direction: 'up',
        scope: { container: 'axis_outcomes', axisId: ids.health },
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Move Training plan down' }));
    await waitFor(() =>
      expect(reorder).toHaveBeenLastCalledWith({
        target: { kind: 'project', id: ids.trainingPlan, revision: 4 },
        direction: 'down',
        scope: { container: 'axis_projects', axisId: ids.health },
      }),
    );
  });

  it('adds an Outcome in this Axis and opens it', async () => {
    const user = userEvent.setup();
    const createOutcome = vi.fn(() =>
      Promise.resolve(receipt({ type: 'outcome', id: ids.halfMarathon })),
    );
    renderAxis(
      fakeAlignment({
        getAxis: () => Promise.resolve(axisDetail()),
        createOutcome,
        listChoices: () => Promise.resolve([]),
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Add Outcome…' }));
    const dialog = screen.getByRole('dialog', { name: 'New Outcome' });
    await user.type(within(dialog).getByLabelText('Title'), 'Swim a mile');
    await user.type(within(dialog).getByLabelText('Success definition'), 'One mile, no breaks');
    await user.click(within(dialog).getByRole('button', { name: 'Create Outcome' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Outcome page' })).toBeVisible();
    expect(createOutcome).toHaveBeenCalledWith({
      title: 'Swim a mile',
      successDefinition: 'One mile, no breaks',
      axisId: ids.health,
    });
    expect(
      screen.getByText('Outcome created.', { selector: '.navigation-notice span' }),
    ).toBeVisible();
  });

  it('adds a routine with this Axis preset', async () => {
    const user = userEvent.setup();
    const createRoutine = vi.fn(() =>
      Promise.resolve(receipt({ type: 'routine', id: ids.stretch })),
    );
    const planning = alignmentPlanning({
      createRoutine,
      previewRoutine: vi.fn(() => Promise.resolve({ ok: true as const, value: [] })),
    });
    renderAxis(fakeAlignment({ getAxis: () => Promise.resolve(axisDetail()) }), { planning });
    await user.click(await screen.findByRole('button', { name: 'Add routine…' }));
    const dialog = screen.getByRole('dialog', { name: 'New routine in this Axis' });
    await user.type(within(dialog).getByLabelText(/^Title/u), 'Evening walk');
    await user.click(within(dialog).getByRole('button', { name: 'Create routine' }));
    await waitFor(() => expect(createRoutine).toHaveBeenCalled());
    expect(createRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Evening walk', axisId: ids.health }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('archives with its consequences stated', async () => {
    const user = userEvent.setup();
    const archive = vi.fn(() => Promise.resolve(receipt()));
    renderAxis(
      fakeAlignment({
        getAxis: () => Promise.resolve(axisDetail()),
        previewArchive: () =>
          Promise.resolve(
            archiveImpact({ activeChildren: { outcome: 2, project: 1 }, placementKept: false }),
          ),
        archive,
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Archive…' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive this Axis?' });
    expect(
      await within(dialog).findByText(
        '2 Outcomes and 1 Project stay as they are and show that their Axis is archived.',
      ),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Archive Axis' }));
    await waitFor(() =>
      expect(archive).toHaveBeenCalledWith({ kind: 'axis', id: ids.health, revision: 3 }),
    );
  });

  it('is read-only when archived, with Restore', async () => {
    const user = userEvent.setup();
    const restore = vi.fn(() => Promise.resolve(receipt()));
    renderAxis(
      fakeAlignment({
        getAxis: () =>
          Promise.resolve(
            axisDetail({
              axis: axisSummary({
                state: 'archived',
                archivedAt: '2026-09-27T00:00:00.000Z' as Instant,
              }),
            }),
          ),
        restore,
      }),
    );
    expect(await screen.findByText('Axis · Archived')).toBeVisible();
    expect(screen.getByText('Archived. Restore it to make changes.')).toBeVisible();
    for (const name of ['Edit…', 'Add Outcome…', 'Add Project…', 'Add routine…', 'Archive…'])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete permanently…' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(restore).toHaveBeenCalledWith({ kind: 'axis', id: ids.health, revision: 3 }),
    );
  });

  it('deletes after typing the title and returns to the Axes', async () => {
    const user = userEvent.setup();
    const deletePermanently = vi.fn(() => Promise.resolve(receipt(undefined, { undo: false })));
    renderAxis(
      fakeAlignment({
        getAxis: () => Promise.resolve(axisDetail()),
        previewDelete: () => Promise.resolve(deleteImpact()),
        deletePermanently,
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Delete permanently…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this Axis permanently?' });
    await user.click(await within(dialog).findByRole('button', { name: 'Continue' }));
    await user.type(within(dialog).getByLabelText('Type the Axis title to confirm'), 'Health');
    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Axes' })).toBeVisible();
    expect(
      screen.getByText('Axis deleted.', { selector: '.navigation-notice span' }),
    ).toBeVisible();
  });

  it('shows a safe state for malformed and missing links', async () => {
    const getAxis = vi.fn(() => Promise.resolve(null));
    const view = renderAxis(fakeAlignment({ getAxis }), { path: '/axis/not-an-axis' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This Axis is unavailable' }),
    ).toBeVisible();
    expect(getAxis).not.toHaveBeenCalled();
    view.unmount();
    renderAxis(fakeAlignment({ getAxis }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This Axis is unavailable' }),
    ).toBeVisible();
    expect(getAxis).toHaveBeenCalledWith(ids.health, { includeFinished: false });
  });
});
