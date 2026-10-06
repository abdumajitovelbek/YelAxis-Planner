// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  ActionApplication,
  AlignmentApplication,
  CaptureIntent,
  PlanningApplication,
  ProjectDetail,
} from '@yelaxis/application';

import { installDialogPolyfill } from '../plan/__fixtures__/c1-planning-fake';
import { notifyPlanChanged } from '../plan/planning-context';
import { lastProps, resetStandIns, wasRendered } from './__fixtures__/detail-dialog-mocks';
import {
  actionsFake,
  fakeAlignment,
  forbiddenCopy,
  ids,
  linked,
  planningFake,
  projectDetail,
  receipt,
  renderDetail,
  uuid,
  without,
} from './__fixtures__/detail-fixtures';
import { ProjectDetailPage } from './project-detail';

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

function renderProject(
  options: {
    readonly detail?: ProjectDetail | null;
    readonly getProject?: AlignmentApplication['getProject'];
    readonly alignment?: Partial<AlignmentApplication>;
    readonly planning?: Partial<PlanningApplication>;
    readonly actions?: Partial<ActionApplication>;
    readonly path?: string;
  } = {},
) {
  const getProject =
    options.getProject ??
    vi.fn().mockResolvedValue(options.detail === undefined ? projectDetail() : options.detail);
  renderDetail({
    path: options.path ?? `/projects/${ids.project}`,
    route: '/projects/:projectId',
    element: <ProjectDetailPage />,
    alignment: fakeAlignment({ getProject, ...options.alignment }),
    planning: planningFake(options.planning),
    actions: actionsFake(options.actions),
  });
  return { getProject };
}

const title = async (): Promise<HTMLElement> =>
  screen.findByRole('heading', { level: 1, name: 'Research notes' });

const ref = { kind: 'project', id: ids.project, revision: 5 } as const;

describe('Project detail page', () => {
  it('shows the facts, next action, links, Actions, and notes under one h1', async () => {
    const { getProject } = renderProject();
    expect(await title()).toBeVisible();
    expect(getProject).toHaveBeenCalledWith(ids.project, undefined);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Project · Active')).toBeVisible();
    expect(screen.getByText('Sources for every chapter are organized')).toBeVisible();
    expect(screen.getByText('Target Sep 1, 2026 – Oct 30, 2026')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Craft' })).toHaveAttribute(
      'href',
      `/axis/${ids.axis}`,
    );
    expect(screen.getByRole('link', { name: 'September 2026' })).toHaveAttribute(
      'href',
      '/plan/month/2026-09-01',
    );
    expect(screen.getByText('Collect and tag sources')).toBeVisible();

    const next = screen.getByText('Next action:').closest('p');
    expect(next).not.toBeNull();
    expect(
      within(next as HTMLElement).getByRole('link', { name: 'Outline scene list' }),
    ).toHaveAttribute('href', `/actions/${ids.action}`);
    expect(screen.queryByText('No next action yet.')).not.toBeInTheDocument();

    expect(
      within(screen.getByRole('list', { name: 'Primary Outcome of Research notes' })).getByRole(
        'link',
        { name: 'Finish the manuscript' },
      ),
    ).toHaveAttribute('href', `/outcomes/${ids.outcome}`);
    expect(
      within(
        screen.getByRole('list', { name: 'Outcomes that Research notes also supports' }),
      ).getByRole('link', { name: 'Share early chapters' }),
    ).toHaveAttribute('href', `/outcomes/${ids.otherOutcome}`);
    expect(
      within(
        screen.getByRole('list', { name: 'Milestones that Research notes supports' }),
      ).getByRole('link', { name: 'Draft chapter two' }),
    ).toHaveAttribute('href', `/milestones/${ids.milestone}`);

    const actions = within(
      screen.getByRole('list', { name: 'Actions of Research notes' }),
    ).getAllByRole('listitem');
    expect(actions).toHaveLength(2);
    expect(actions[0]).toHaveTextContent('Outline scene list');
    expect(actions[0]).toHaveTextContent('Planned');
    expect(actions[1]).toHaveTextContent('Order reference books');
    expect(actions[1]).toHaveTextContent('Completed');
    expect(screen.queryByRole('button', { name: /Show all/u })).not.toBeInTheDocument();

    expect(screen.getByLabelText('Project notes')).toHaveValue('Ask the library about archives');
    expect(
      within(screen.getByRole('list', { name: 'Captured notes' })).getByText(
        'Archive hours change in winter',
      ),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'History' })).toHaveTextContent('Created');
    expect(document.body.textContent).not.toMatch(forbiddenCopy);
    expect(lastProps('DangerZone')).toMatchObject({
      target: { ...ref, title: 'Research notes' },
      parentPath: `/outcomes/${ids.outcome}`,
    });
  });

  it('shows the next-action notice only for an active Project without one', async () => {
    renderProject({ detail: projectDetail({}, { nextAction: { status: 'missing' } }) });
    await title();
    expect(screen.getByText('No next action yet.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add next action…' })).toBeVisible();
    cleanup();

    renderProject({
      detail: projectDetail({}, { state: 'paused', nextAction: { status: 'not_applicable' } }),
    });
    await title();
    expect(screen.queryByText('No next action yet.')).not.toBeInTheDocument();
    expect(screen.queryByText('Next action:')).not.toBeInTheDocument();
  });

  it('adds a next action by capture with this Project and offers no planning undo', async () => {
    const user = userEvent.setup();
    const intent: CaptureIntent = {
      commandId: uuid(201),
      actionId: uuid(202),
      origin: 'project',
    };
    const newCaptureIntent = vi.fn(() => intent);
    const capture = vi.fn().mockResolvedValue(receipt());
    renderProject({
      detail: projectDetail({}, { nextAction: { status: 'missing' } }),
      actions: { newCaptureIntent, capture },
    });
    await user.click(await screen.findByRole('button', { name: 'Add next action…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an action' });
    await user.click(within(dialog).getByRole('button', { name: 'Add action' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Give the action a title.');
    expect(capture).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText('Title'), 'Email the archivist');
    await user.click(within(dialog).getByRole('button', { name: 'Add action' }));
    expect(newCaptureIntent).toHaveBeenCalledWith('project');
    expect(capture).toHaveBeenCalledWith(intent, {
      title: 'Email the archivist',
      projectId: ids.project,
    });
    expect(await screen.findByText('Action added to this Project.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('reorders Actions within the Project and shows all of them on request', async () => {
    const user = userEvent.setup();
    const reorder = vi.fn().mockResolvedValue(receipt());
    const partial = projectDetail({
      actions: { ...projectDetail().actions, total: 3 },
    });
    const getProject = vi.fn().mockResolvedValue(partial);
    renderProject({ getProject, alignment: { reorder } });
    const list = await screen.findByRole('list', { name: 'Actions of Research notes' });
    const [first] = within(list).getAllByRole('listitem');
    await user.click(within(first as HTMLElement).getByRole('button', { name: /down/iu }));
    expect(reorder).toHaveBeenCalledWith({
      target: { kind: 'action', id: ids.action, revision: 2 },
      direction: 'down',
      scope: { container: 'project_actions', projectId: ids.project },
    });
    expect(await screen.findByText('Moved “Outline scene list” down.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show all 3 actions' }));
    await waitFor(() =>
      expect(getProject).toHaveBeenLastCalledWith(ids.project, { actionLimit: 200 }),
    );
  });

  it('saves the Project notes and keeps every other field', async () => {
    const user = userEvent.setup();
    const editProject = vi.fn().mockResolvedValue(receipt());
    renderProject({ alignment: { editProject } });
    const notes = await screen.findByLabelText('Project notes');
    const save = screen.getByRole('button', { name: 'Save notes' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    await user.click(save);
    expect(editProject).not.toHaveBeenCalled();
    await user.clear(notes);
    await user.type(notes, 'Visit the archive on Friday');
    expect(screen.getByText('27 of 10,000 characters')).toBeVisible();
    expect(save).toHaveAttribute('aria-disabled', 'false');
    await user.click(save);
    expect(editProject).toHaveBeenCalledWith(ref, {
      title: 'Research notes',
      desiredResult: 'Sources for every chapter are organized',
      description: 'Collect and tag sources',
      notes: 'Visit the archive on Friday',
      targetStart: '2026-09-01',
      targetEnd: '2026-10-30',
    });
    expect(await screen.findByText('Notes saved.')).toBeInTheDocument();
    // Saving keeps focus on the notes controls instead of dropping it.
    expect(save).toHaveFocus();
  });

  it('keeps a notes draft while editing and shows committed notes otherwise', async () => {
    const user = userEvent.setup();
    const getProject = vi.fn().mockResolvedValue(projectDetail());
    renderProject({ getProject });
    const notes = await screen.findByLabelText('Project notes');
    getProject.mockResolvedValue(
      projectDetail({}, { notes: 'Changed from Edit…', localRevision: 6 }),
    );
    act(() => notifyPlanChanged());
    await waitFor(() => expect(notes).toHaveValue('Changed from Edit…'));

    await user.type(notes, ' and a draft');
    getProject.mockResolvedValue(projectDetail({}, { notes: 'Changed again', localRevision: 7 }));
    act(() => notifyPlanChanged());
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(3));
    expect(notes).toHaveValue('Changed from Edit… and a draft');
  });

  it('asks before leaving with unsaved notes', async () => {
    const user = userEvent.setup();
    renderProject();
    await user.type(await screen.findByLabelText('Project notes'), ' and more');
    await user.click(screen.getByRole('link', { name: 'Craft' }));
    const guard = await screen.findByRole('dialog', { name: 'Save your changes before leaving?' });
    await user.click(within(guard).getByRole('button', { name: 'Continue editing' }));
    expect(screen.getByLabelText('Project notes')).toHaveValue(
      'Ask the library about archives and more',
    );
    expect(screen.getByTestId('location')).toHaveTextContent(`/projects/${ids.project}`);
  });

  it('clears the notes when they are emptied', async () => {
    const user = userEvent.setup();
    const editProject = vi.fn().mockResolvedValue(receipt());
    renderProject({ alignment: { editProject } });
    await user.clear(await screen.findByLabelText('Project notes'));
    await user.click(screen.getByRole('button', { name: 'Save notes' }));
    expect(editProject).toHaveBeenCalledWith(
      ref,
      expect.not.objectContaining({ notes: expect.anything() as unknown }),
    );
  });

  it('offers the state changes of the current state', async () => {
    const user = userEvent.setup();
    const transitionProject = vi.fn().mockResolvedValue(receipt());
    renderProject({ alignment: { transitionProject } });
    await title();
    const group = screen.getByRole('group', { name: 'Project actions' });
    expect(within(group).getByRole('button', { name: 'Mark blocked' })).toBeVisible();
    expect(within(group).getByRole('button', { name: 'Pause' })).toBeVisible();
    expect(within(group).queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();
    await user.click(within(group).getByRole('button', { name: 'Complete' }));
    expect(transitionProject).toHaveBeenCalledWith(ref, 'completed');
    expect(await screen.findByText('Project completed.')).toBeInTheDocument();
    cleanup();

    const idea = projectDetail({}, { state: 'idea', nextAction: { status: 'not_applicable' } });
    renderProject({
      detail: { ...idea, project: without(idea.project, 'desiredResult') },
    });
    await title();
    const ideaGroup = screen.getByRole('group', { name: 'Project actions' });
    expect(within(ideaGroup).getByRole('button', { name: 'Activate' })).toBeVisible();
    expect(
      screen.getByText('Add a desired result with Edit… before activating this Project.'),
    ).toBeVisible();
    expect(screen.getByText('Not set yet')).toBeVisible();
    cleanup();

    renderProject({
      detail: projectDetail({}, { state: 'completed', nextAction: { status: 'not_applicable' } }),
    });
    await title();
    const done = screen.getByRole('group', { name: 'Project actions' });
    expect(within(done).getByRole('button', { name: 'Reopen' })).toBeVisible();
    expect(within(done).queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument();
  });

  it('adds the Project to this week and places it in a year, month, or week', async () => {
    const user = userEvent.setup();
    const addWeekCommitment = vi.fn().mockResolvedValue(receipt());
    const place = vi.fn().mockResolvedValue(receipt());
    renderProject({ planning: { addWeekCommitment, place } });
    await title();
    await user.click(screen.getByRole('button', { name: 'Add to this week' }));
    expect(addWeekCommitment).toHaveBeenCalledWith({
      weekDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) as unknown,
      target: { kind: 'project', id: ids.project },
    });
    expect(await screen.findByText('Added to this week’s commitments.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Place…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place “Research notes”' });
    for (const name of ['A year', 'A month', 'A week'])
      expect(within(dialog).getByRole('radio', { name })).toBeVisible();
    await user.click(within(dialog).getByRole('radio', { name: 'A week' }));
    fireEvent.change(within(dialog).getByLabelText('Any date in the week'), {
      target: { value: '2026-10-07' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Place' }));
    expect(place).toHaveBeenCalledWith({
      target: ref,
      period: { kind: 'week', date: '2026-10-07' },
    });
    expect(
      await screen.findByText('Placed in the week that includes Wednesday, October 7, 2026.'),
    ).toBeInTheDocument();
  });

  it('schedules an unfinished Action through the shared Schedule dialog', async () => {
    const user = userEvent.setup();
    renderProject();
    await title();
    expect(
      screen.queryByRole('button', { name: 'Schedule… Order reference books' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Schedule… Outline scene list' }));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule “Outline scene list”' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('links Outcomes, Milestones, and Actions, and unlinks each kind', async () => {
    const user = userEvent.setup();
    renderProject();
    await title();
    const focus = { kind: 'project', id: ids.project, localRevision: 5 };
    const opens = [
      ['Link an Outcome…', ['outcome_primary_project', 'outcome_secondary_project']],
      ['Link a milestone…', ['milestone_project']],
      ['Link an action…', ['project_action']],
    ] as const;
    for (const [name, relationships] of opens) {
      await user.click(screen.getByRole('button', { name }));
      expect(lastProps('LinkDialog')).toMatchObject({ open: true, focus, relationships });
      await user.click(screen.getByRole('button', { name: 'Close LinkDialog' }));
    }

    const unlinks = [
      [
        'Unlink… Finish the manuscript',
        {
          relationship: 'outcome_primary_project',
          direction: 'up',
          other: { kind: 'outcome', id: ids.outcome },
        },
      ],
      [
        'Unlink… Share early chapters',
        {
          relationship: 'outcome_secondary_project',
          direction: 'up',
          linkId: ids.link,
          linkRevision: 2,
          other: { kind: 'outcome', id: ids.otherOutcome },
        },
      ],
      [
        'Unlink… Draft chapter two',
        {
          relationship: 'milestone_project',
          direction: 'up',
          linkId: ids.linkTwo,
          linkRevision: 1,
          other: { kind: 'milestone', id: ids.milestone },
        },
      ],
      [
        'Unlink… Outline scene list',
        {
          relationship: 'project_action',
          direction: 'down',
          other: { kind: 'action', id: ids.action, localRevision: 2 },
        },
      ],
    ] as const;
    for (const [name, edge] of unlinks) {
      await user.click(screen.getByRole('button', { name }));
      expect(lastProps('UnlinkDialog')).toMatchObject({ open: true, focus, edge });
      await user.click(screen.getByRole('button', { name: 'Close UnlinkDialog' }));
    }
  });

  it('opens the shared edit form with the whole Project', async () => {
    const user = userEvent.setup();
    renderProject();
    await title();
    await user.click(screen.getByRole('button', { name: 'Edit…' }));
    expect(lastProps('ProjectFormDialog')).toMatchObject({
      open: true,
      mode: 'edit',
      initial: { id: ids.project, notes: 'Ask the library about archives' },
    });
  });

  it('keeps an archived Project read-only with Restore', async () => {
    renderProject({
      detail: projectDetail(
        {
          capturedNotes: { items: [linked('note', ids.note, 'Opening hours')], total: 1 },
        },
        { state: 'archived', nextAction: { status: 'not_applicable' } },
      ),
    });
    await title();
    expect(screen.getByText('Archived. Restore it to make changes.')).toBeVisible();
    expect(lastProps('ArchivedNotice')['target']).toEqual({ ...ref, title: 'Research notes' });
    expect(screen.queryByRole('group', { name: 'Project actions' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Project notes')).not.toBeInTheDocument();
    expect(screen.getByText('Ask the library about archives')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /schedule|unlink|link a|link an|add |move/iu }),
    ).not.toBeInTheDocument();
    expect(wasRendered('DangerZone')).toBe(true);
  });

  it('shows the unavailable state for a malformed id without reading', async () => {
    const getProject = vi.fn();
    renderProject({ getProject, path: '/projects/not-a-project' });
    expect(
      await screen.findByRole('heading', { level: 1, name: /this project is unavailable/iu }),
    ).toBeVisible();
    expect(getProject).not.toHaveBeenCalled();
  });

  it('shows the unavailable state for a missing Project', async () => {
    renderProject({ detail: null });
    expect(
      await screen.findByRole('heading', { level: 1, name: /this project is unavailable/iu }),
    ).toBeVisible();
  });

  it('recovers from a read error with Try again', async () => {
    const user = userEvent.setup();
    const getProject = vi
      .fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(projectDetail());
    renderProject({ getProject });
    expect(await screen.findByRole('alert')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await title()).toBeVisible();
  });
});
