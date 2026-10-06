// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  AlignmentApplication,
  MilestoneDetail,
  PlanningApplication,
} from '@yelaxis/application';

import { installDialogPolyfill } from '../plan/__fixtures__/c1-planning-fake';
import { lastProps, resetStandIns } from './__fixtures__/detail-dialog-mocks';
import {
  fakeAlignment,
  forbiddenCopy,
  ids,
  milestoneDetail,
  node,
  planningFake,
  receipt,
  renderDetail,
  without,
} from './__fixtures__/detail-fixtures';
import { MilestoneDetailPage } from './milestone-detail';

vi.mock(
  './object-forms',
  async () => (await import('./__fixtures__/detail-dialog-mocks')).objectFormsStandIns,
);
vi.mock(
  './lifecycle-dialogs',
  async () => (await import('./__fixtures__/detail-dialog-mocks')).lifecycleDialogsStandIns,
);
vi.mock(
  './link-dialogs',
  async () => (await import('./__fixtures__/detail-dialog-mocks')).linkDialogsStandIns,
);

beforeAll(() => installDialogPolyfill());

afterEach(() => {
  cleanup();
  resetStandIns();
});

function renderMilestone(
  options: {
    readonly detail?: MilestoneDetail | null;
    readonly getMilestone?: AlignmentApplication['getMilestone'];
    readonly alignment?: Partial<AlignmentApplication>;
    readonly planning?: Partial<PlanningApplication>;
    readonly path?: string;
  } = {},
) {
  const getMilestone =
    options.getMilestone ??
    vi.fn().mockResolvedValue(options.detail === undefined ? milestoneDetail() : options.detail);
  renderDetail({
    path: options.path ?? `/milestones/${ids.milestone}`,
    route: '/milestones/:milestoneId',
    element: <MilestoneDetailPage />,
    alignment: fakeAlignment({ getMilestone, ...options.alignment }),
    planning: planningFake(options.planning),
  });
  return { getMilestone };
}

const title = async (): Promise<HTMLElement> =>
  screen.findByRole('heading', { level: 1, name: 'Draft chapter two' });

const ref = { kind: 'milestone', id: ids.milestone, revision: 3 } as const;

describe('Milestone detail page', () => {
  it('shows the alignment chain, facts, and supporting work under one h1', async () => {
    const { getMilestone } = renderMilestone();
    expect(await title()).toBeVisible();
    expect(getMilestone).toHaveBeenCalledWith(ids.milestone);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Milestone · Active')).toBeVisible();

    const steps = within(
      screen.getByRole('list', { name: 'Alignment from Axis to Milestone' }),
    ).getAllByRole('listitem');
    expect(steps).toHaveLength(3);
    expect(within(steps[0] as HTMLElement).getByRole('link', { name: 'Craft' })).toHaveAttribute(
      'href',
      `/axis/${ids.axis}`,
    );
    expect(
      within(steps[1] as HTMLElement).getByRole('link', { name: 'Finish the manuscript' }),
    ).toHaveAttribute('href', `/outcomes/${ids.outcome}`);
    expect(steps[1]).toHaveTextContent('Active');
    expect(steps[2]).toHaveTextContent('Milestone (this page)');
    expect(steps[2]).toHaveTextContent('Draft chapter two');

    expect(screen.getByText('Chapter two has a complete first draft')).toBeVisible();
    expect(screen.getByText('Target Aug 1, 2026 – Aug 28, 2026')).toBeVisible();
    expect(screen.getByRole('link', { name: 'August 2026' })).toHaveAttribute(
      'href',
      '/plan/month/2026-08-01',
    );
    expect(
      within(screen.getByRole('list', { name: 'Projects supporting Draft chapter two' })).getByRole(
        'link',
        { name: 'Research notes' },
      ),
    ).toHaveAttribute('href', `/projects/${ids.project}`);
    expect(
      within(screen.getByRole('list', { name: 'Actions supporting Draft chapter two' })).getByRole(
        'link',
        { name: 'Outline scene list' },
      ),
    ).toHaveAttribute('href', `/actions/${ids.action}`);

    // The required Outcome link is moved, never unlinked.
    expect(screen.getByRole('button', { name: 'Move to another Outcome…' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /unlink… finish the manuscript/iu }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'History' })).toHaveTextContent('Link added');
    expect(document.body.textContent).not.toMatch(forbiddenCopy);
    expect(lastProps('DangerZone')).toMatchObject({
      target: { ...ref, title: 'Draft chapter two' },
      parentPath: `/outcomes/${ids.outcome}`,
    });
  });

  it('says calmly when there is no Axis or support, and marks an archived parent', async () => {
    const detail = milestoneDetail(
      { projects: { items: [], total: 0 }, actions: { items: [], total: 0 } },
      { outcome: node(ids.outcome, 'Finish the manuscript', 'archived', true) },
    );
    renderMilestone({ detail: without(detail, 'axis') });
    await title();
    expect(screen.getByText('No Axis linked')).toBeVisible();
    expect(screen.getByText('No projects support this milestone yet.')).toBeVisible();
    expect(screen.getByText('No actions support this milestone yet.')).toBeVisible();
    expect(screen.getAllByText('Archived parent').length).toBeGreaterThan(0);
  });

  it('completes, cancels, and reopens only by an explicit choice', async () => {
    const user = userEvent.setup();
    const transitionMilestone = vi.fn().mockResolvedValue(receipt());
    renderMilestone({ alignment: { transitionMilestone } });
    await title();
    const group = screen.getByRole('group', { name: 'Milestone actions' });
    expect(within(group).getByRole('button', { name: 'Cancel milestone' })).toBeVisible();
    expect(within(group).queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
    await user.click(within(group).getByRole('button', { name: 'Complete' }));
    expect(transitionMilestone).toHaveBeenCalledWith(ref, 'completed');
    expect(await screen.findByText('Milestone completed.')).toBeInTheDocument();
    cleanup();

    renderMilestone({ detail: milestoneDetail({}, { state: 'canceled' }) });
    await title();
    const canceled = screen.getByRole('group', { name: 'Milestone actions' });
    expect(within(canceled).getByRole('button', { name: 'Reopen' })).toBeVisible();
    expect(within(canceled).queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument();
  });

  it('moves the placement and the target window separately, without reopening', async () => {
    const user = userEvent.setup();
    const place = vi.fn().mockResolvedValue(receipt());
    const editMilestone = vi.fn().mockResolvedValue(receipt());
    const transitionMilestone = vi.fn();
    renderMilestone({
      detail: milestoneDetail({}, { state: 'completed' }),
      planning: { place },
      alignment: { editMilestone, transitionMilestone },
    });
    await title();
    await user.click(screen.getByRole('button', { name: 'Move…' }));
    let dialog = await screen.findByRole('dialog', { name: 'Move “Draft chapter two”' });
    expect(within(dialog).getByRole('radio', { name: 'A month' })).toBeChecked();
    expect(within(dialog).queryByRole('radio', { name: 'A year' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'A week' }));
    fireEvent.change(within(dialog).getByLabelText('Any date in the week'), {
      target: { value: '2026-08-12' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Move placement' }));
    expect(place).toHaveBeenCalledWith({
      target: ref,
      period: { kind: 'week', date: '2026-08-12' },
    });
    expect(
      await screen.findByText('Placed in the week that includes Wednesday, August 12, 2026.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Move…' }));
    dialog = await screen.findByRole('dialog', { name: 'Move “Draft chapter two”' });
    fireEvent.change(within(dialog).getByLabelText('Target start'), {
      target: { value: '2026-09-10' },
    });
    fireEvent.change(within(dialog).getByLabelText('Target end'), {
      target: { value: '2026-09-01' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Save target window' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The target window starts after it ends.',
    );
    expect(editMilestone).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Target end'), {
      target: { value: '2026-09-30' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Save target window' }));
    expect(editMilestone).toHaveBeenCalledWith(ref, {
      title: 'Draft chapter two',
      measurableCheckpoint: 'Chapter two has a complete first draft',
      targetStart: '2026-09-10',
      targetEnd: '2026-09-30',
    });
    expect(await screen.findByText('Target window saved.')).toBeInTheDocument();
    expect(transitionMilestone).not.toHaveBeenCalled();
  });

  it('opens the shared edit, reparent, and archive dialogs with this Milestone', async () => {
    const user = userEvent.setup();
    renderMilestone();
    await title();
    await user.click(screen.getByRole('button', { name: 'Edit…' }));
    expect(lastProps('MilestoneFormDialog')).toMatchObject({
      open: true,
      mode: 'edit',
      initial: { id: ids.milestone, localRevision: 3 },
    });
    await user.click(screen.getByRole('button', { name: 'Close MilestoneFormDialog' }));

    await user.click(screen.getByRole('button', { name: 'Move to another Outcome…' }));
    expect(lastProps('ReparentMilestoneDialog')).toMatchObject({
      open: true,
      milestone: { ...ref, title: 'Draft chapter two', outcomeId: ids.outcome },
    });
    await user.click(screen.getByRole('button', { name: 'Close ReparentMilestoneDialog' }));

    await user.click(screen.getByRole('button', { name: 'Archive…' }));
    expect(lastProps('ArchiveDialog')).toMatchObject({
      open: true,
      target: { ...ref, title: 'Draft chapter two' },
    });
  });

  it('links and unlinks supporting Projects and Actions', async () => {
    const user = userEvent.setup();
    renderMilestone();
    await title();
    const focus = { kind: 'milestone', id: ids.milestone, localRevision: 3 };
    await user.click(screen.getByRole('button', { name: 'Link a project…' }));
    expect(lastProps('LinkDialog')).toMatchObject({
      open: true,
      focus,
      relationships: ['milestone_project'],
    });
    await user.click(screen.getByRole('button', { name: 'Close LinkDialog' }));
    await user.click(screen.getByRole('button', { name: 'Link an action…' }));
    expect(lastProps('LinkDialog')).toMatchObject({ relationships: ['milestone_action'] });
    await user.click(screen.getByRole('button', { name: 'Close LinkDialog' }));

    await user.click(screen.getByRole('button', { name: 'Unlink… Research notes' }));
    expect(lastProps('UnlinkDialog')).toMatchObject({
      open: true,
      focus,
      edge: {
        relationship: 'milestone_project',
        direction: 'down',
        required: false,
        linkId: ids.link,
        linkRevision: 3,
        other: { kind: 'project', id: ids.project },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Close UnlinkDialog' }));
    await user.click(screen.getByRole('button', { name: 'Unlink… Outline scene list' }));
    expect(lastProps('UnlinkDialog')).toMatchObject({
      edge: {
        relationship: 'milestone_action',
        linkId: ids.linkTwo,
        linkRevision: 1,
        other: { kind: 'action', id: ids.action },
      },
    });
  });

  it('keeps an archived Milestone read-only with Restore', async () => {
    renderMilestone({
      detail: milestoneDetail({}, { state: 'archived', stateBeforeArchive: 'active' }),
    });
    await title();
    expect(screen.getByText('Archived. Restore it to make changes.')).toBeVisible();
    expect(lastProps('ArchivedNotice')['target']).toEqual({ ...ref, title: 'Draft chapter two' });
    expect(screen.queryByRole('group', { name: 'Milestone actions' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /unlink|link a|link an|move/iu }),
    ).not.toBeInTheDocument();
  });

  it('shows the unavailable state for a malformed id without reading', async () => {
    const getMilestone = vi.fn();
    renderMilestone({ getMilestone, path: '/milestones/not-a-milestone' });
    expect(
      await screen.findByRole('heading', { level: 1, name: /this milestone is unavailable/iu }),
    ).toBeVisible();
    expect(getMilestone).not.toHaveBeenCalled();
  });

  it('shows the unavailable state for a missing Milestone', async () => {
    renderMilestone({ detail: null });
    expect(
      await screen.findByRole('heading', { level: 1, name: /this milestone is unavailable/iu }),
    ).toBeVisible();
  });

  it('recovers from a read error with Try again', async () => {
    const user = userEvent.setup();
    const getMilestone = vi
      .fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(milestoneDetail());
    renderMilestone({ getMilestone });
    expect(await screen.findByRole('alert')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await title()).toBeVisible();
  });
});
