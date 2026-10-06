// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  ActionApplication,
  ActionCanonicalDocument,
  ActionWorkspace,
  AlignmentApplication,
  AlignmentNeighborhood,
  ApplicationResult,
  CapacitySettings,
  CaptureIntent,
  CommandReceipt,
  MilestoneChoice,
  PlanningApplication,
} from '@yelaxis/application';
import type { CommandId, IanaTimeZone, Instant, OwnerId, UUID } from '@yelaxis/domain';

import { ActionDetailPage, crossAxisPending, GlobalCapture, InboxPage } from './actions-ui';
import {
  edge,
  fakeAlignment,
  guide,
  node,
  outline,
  receipt,
  uuid,
} from './alignment/__fixtures__/w3-alignment-fixtures';
import { PlanningProvider } from './plan/planning-context';

const intent: CaptureIntent = {
  commandId: '10000000-0000-4000-8000-000000000001' as CommandId,
  actionId: '20000000-0000-4000-8000-000000000001' as UUID,
  origin: 'global_capture',
};

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});

afterEach(() => cleanup());

describe('Action surfaces', () => {
  it('focuses capture, preserves an invalid draft, and returns focus to the title', async () => {
    const capture = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: { code: 'invalid_value', message: 'The Action fields are not valid.' },
      },
    });
    const application = stubApplication({ capture });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <GlobalCapture application={application} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /Capture Alt C/u }));
    const title = screen.getByRole('textbox', { name: /Title/u });
    await waitFor(() => expect(title).toHaveFocus());
    await user.type(title, '   ');
    await user.click(screen.getByRole('button', { name: /^Capture$/u }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not valid');
    expect(title).toHaveValue('   ');
    await waitFor(() => expect(title).toHaveFocus());
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('keeps focus on a button reached before the next frame after opening capture', async () => {
    const queued: FrameRequestCallback[] = [];
    const frame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => queued.push(callback));
    try {
      render(
        <MemoryRouter>
          <GlobalCapture application={stubApplication()} />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole('button', { name: /Capture Alt C/u }));
      expect(screen.getByRole('textbox', { name: /Title/u })).toHaveFocus();
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      cancel.focus();
      act(() => {
        for (const callback of queued.splice(0)) callback(0);
      });
      expect(cancel).toHaveFocus();
      // Let the choices finish loading inside the test.
      await waitFor(() => expect(cancel).toBeEnabled());
    } finally {
      frame.mockRestore();
    }
  });

  it('renders a semantic, actionable empty Inbox state', async () => {
    const application = stubApplication();
    render(
      <MemoryRouter>
        <InboxPage application={application} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Decide what happens next.' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Nothing waiting for a decision.' })).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Inbox Actions' })).not.toBeInTheDocument();
  });
});

describe('Repeat after this: default start date', () => {
  afterEach(() => vi.useRealTimers());

  const owner = '50000000-0000-4000-8000-000000000001' as OwnerId;
  function workspaceWith(
    changes: Partial<ActionWorkspace> & { readonly due?: unknown },
  ): ActionWorkspace & { readonly overdue: boolean } {
    const { due, ...rest } = changes;
    return {
      action: {
        ref: { type: 'action', id: intent.actionId, ownerId: owner },
        localRevision: 1,
        serverRevision: 0,
        baseSnapshotHash: null,
        document: {
          title: 'Water the garden',
          captureOrigin: 'global_capture',
          orderKey: 'a0',
          state: 'backlog',
          ...(due === undefined ? {} : { due }),
        },
      },
      createdAt: '2026-09-20T10:00:00.000Z' as Instant,
      placement: null,
      plannedBlock: null,
      reminder: null,
      overdue: false,
      ...rest,
    };
  }

  async function openedStartsOn(
    workspace: ActionWorkspace & { readonly overdue: boolean },
  ): Promise<HTMLElement> {
    const application = stubApplication({ getAction: () => Promise.resolve(workspace) });
    const user = userEvent.setup();
    render(
      <PlanningProvider planning={fakePlanning({})} actions={application}>
        <MemoryRouter initialEntries={[`/actions/${intent.actionId}`]}>
          <Routes>
            <Route
              path="/actions/:actionId"
              element={<ActionDetailPage application={application} />}
            />
          </Routes>
        </MemoryRouter>
      </PlanningProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Repeat after this…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Repeat after this' });
    return within(dialog).getByLabelText('Starts on');
  }

  it('starts the day after planning-zone today when the Action has no date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 01:30 on September 28 in Europe/Berlin, the planning zone.
    vi.setSystemTime(new Date('2026-09-27T23:30:00Z'));
    const startsOn = await openedStartsOn(workspaceWith({}));
    await waitFor(() => expect(startsOn).toHaveValue('2026-09-29'));
  });

  it('starts the day after a due date when the Action has no placement', async () => {
    const startsOn = await openedStartsOn(
      workspaceWith({ due: { kind: 'date', date: '2099-05-01' } }),
    );
    expect(startsOn).toHaveValue('2099-05-02');
  });

  it('starts after the planned block local date in the planning zone', async () => {
    const startsOn = await openedStartsOn(
      workspaceWith({
        plannedBlock: {
          ref: {
            type: 'time_block',
            id: '70000000-0000-4000-8000-000000000009' as UUID,
            ownerId: owner,
          },
          localRevision: 1,
          serverRevision: 0,
          baseSnapshotHash: null,
          document: {
            target: { kind: 'action', actionId: intent.actionId },
            startsAt: '2099-03-10T23:30:00.000Z',
            endsAt: '2099-03-11T00:30:00.000Z',
            timeZone: 'UTC',
            state: 'planned',
          },
        },
      }),
    );
    // 23:30 UTC is 00:30 on March 11 in Europe/Berlin.
    expect(startsOn).toHaveValue('2099-03-12');
  });
});

function stubApplication(overrides: Partial<ActionApplication> = {}): ActionApplication {
  const unused = () => Promise.reject(new Error('Unexpected Action application call'));
  return {
    newCaptureIntent: () => intent,
    capture: unused,
    listInbox: () => Promise.resolve({ items: [], total: 0 }),
    listAllInbox: () => Promise.resolve([]),
    getAction: () => Promise.resolve(null),
    listAxes: () => Promise.resolve([]),
    listProjects: () => Promise.resolve([]),
    listMilestones: () => Promise.resolve([]),
    edit: unused,
    triage: unused,
    transition: unused,
    reorder: unused,
    bulk: unused,
    undo: unused,
    deletePermanently: unused,
    ...overrides,
  };
}

const settings: CapacitySettings = {
  profile: {
    profileId: '30000000-0000-4000-8000-000000000001' as UUID,
    planningTimeZone: 'Europe/Berlin' as IanaTimeZone,
    weekStart: 'monday',
    timeFormat: '24_hour',
  },
  availability: [],
  rules: {} as CapacitySettings['rules'],
};

function routineReceipt(): ApplicationResult<CommandReceipt> {
  return {
    ok: true,
    value: {
      commandId: intent.commandId,
      ownerId: '50000000-0000-4000-8000-000000000001' as OwnerId,
      actor: 'user',
      acceptedAt: '2026-09-27T12:00:00.000Z' as Instant,
      canonical: [
        {
          ref: {
            type: 'routine',
            id: '40000000-0000-4000-8000-000000000001' as UUID,
            ownerId: '50000000-0000-4000-8000-000000000001' as OwnerId,
          },
          localRevision: 1,
        },
      ],
      eventIds: [],
      undo: { available: true, undoId: '60000000-0000-4000-8000-000000000001' as UUID },
      sync: { queued: false },
    },
  };
}

const planningMethods: Record<keyof PlanningApplication, true> = {
  getDayPlan: true,
  getWeekPlan: true,
  getMonthPlan: true,
  getYearPlan: true,
  getMilestoneChain: true,
  resolveLocalInterval: true,
  listRoutines: true,
  getRoutine: true,
  previewRoutine: true,
  listTemplates: true,
  getTemplate: true,
  previewTemplate: true,
  getCapacitySettings: true,
  listAxes: true,
  listProjects: true,
  createCustomBlock: true,
  scheduleAction: true,
  moveBlock: true,
  shortenBlock: true,
  setBlockState: true,
  keepOverlap: true,
  createCommitment: true,
  place: true,
  unplace: true,
  carryForward: true,
  reorderPlacement: true,
  addWeekCommitment: true,
  removeWeekCommitment: true,
  createRoutine: true,
  repeatAfterAction: true,
  editRoutineDetails: true,
  editRoutineThisAndFuture: true,
  pauseRoutine: true,
  resumeRoutine: true,
  archiveRoutine: true,
  restoreRoutine: true,
  completeOccurrence: true,
  skipOccurrence: true,
  reopenOccurrence: true,
  editOccurrence: true,
  applyTemplate: true,
  duplicateTemplate: true,
  saveTemplate: true,
  archiveTemplate: true,
  restoreTemplate: true,
  saveWeekAsTemplate: true,
  addAvailability: true,
  editAvailability: true,
  archiveConstraint: true,
  setCapacityCap: true,
  setMonthTheme: true,
  clearMonthTheme: true,
  setYearDirection: true,
  clearYearDirection: true,
  previewPlanningZoneChange: true,
  changePlanningZone: true,
  getTimeBlockReminder: true,
  setTimeBlockReminder: true,
  turnOffTimeBlockReminder: true,
  setRoutineReminder: true,
  turnOffRoutineReminder: true,
  undo: true,
};

function fakePlanning(overrides: Partial<PlanningApplication>): PlanningApplication {
  const base = Object.fromEntries(
    Object.keys(planningMethods).map((name) => [
      name,
      () => Promise.reject(new Error(`Unexpected planning call: ${name}`)),
    ]),
  ) as unknown as PlanningApplication;
  return {
    ...base,
    getCapacitySettings: () => Promise.resolve(settings),
    listProjects: () => Promise.resolve([]),
    previewRoutine: () => Promise.resolve({ ok: true, value: [] }),
    ...overrides,
  };
}

describe('planning repeating capture', () => {
  it('hides Repeat when planning services are not provided', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <GlobalCapture application={stubApplication()} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: /Capture Alt C/u }));
    await user.click(screen.getByText('More details'));
    expect(screen.getByRole('checkbox', { name: /Schedule a fixed time/u })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Repeat' })).not.toBeInTheDocument();
  });

  it('creates a Routine with capture details as defaults and no one-off Action', async () => {
    const capture = vi.fn();
    const createRoutine = vi.fn().mockResolvedValue(routineReceipt());
    const application = stubApplication({ capture });
    const user = userEvent.setup();
    render(
      <PlanningProvider planning={fakePlanning({ createRoutine })} actions={application}>
        <MemoryRouter>
          <GlobalCapture application={application} />
        </MemoryRouter>
      </PlanningProvider>,
    );
    const opener = screen.getByRole('button', { name: /Capture Alt C/u });
    await user.click(opener);
    const title = screen.getByRole('textbox', { name: /Title/u });
    await waitFor(() => expect(title).toHaveFocus());
    await user.type(title, 'Water plants');
    await user.click(screen.getByText('More details'));
    await user.type(screen.getByRole('spinbutton', { name: /Estimate/u }), '10');
    await user.click(screen.getByRole('checkbox', { name: 'Repeat' }));
    expect(
      screen.queryByRole('checkbox', { name: /Schedule a fixed time/u }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'A number of times per week' }));
    const count = screen.getByRole('spinbutton', { name: /Times per week/u });
    await user.clear(count);
    await user.type(count, '2');
    await user.click(screen.getByRole('button', { name: 'Create routine' }));

    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(capture).not.toHaveBeenCalled();
    expect(createRoutine.mock.calls[0]?.[0]).toMatchObject({
      title: 'Water plants',
      rule: { version: 1, kind: 'weekly_count', targetCount: 2, weekStart: 'monday' },
      schedulingMode: { kind: 'day_flexible' },
      defaults: { estimateMinutes: 10 },
    });
    expect(await screen.findByText('Routine created.')).toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('starts a Routine after a one-off Action from Action detail', async () => {
    const workspace: ActionWorkspace & { readonly overdue: boolean } = {
      action: {
        ref: {
          type: 'action',
          id: intent.actionId,
          ownerId: '50000000-0000-4000-8000-000000000001' as OwnerId,
        },
        localRevision: 2,
        serverRevision: 0,
        baseSnapshotHash: null,
        document: {
          title: 'Renew passport photos',
          captureOrigin: 'global_capture',
          orderKey: 'a0',
          state: 'planned',
          estimateMinutes: 20,
          priority: 'high',
        },
      },
      createdAt: '2026-09-20T10:00:00.000Z' as Instant,
      placement: {
        ref: {
          type: 'planning_placement',
          id: '70000000-0000-4000-8000-000000000001' as UUID,
          ownerId: '50000000-0000-4000-8000-000000000001' as OwnerId,
        },
        localRevision: 1,
        serverRevision: 0,
        baseSnapshotHash: null,
        document: {
          target: { kind: 'action', actionId: intent.actionId },
          period: { kind: 'day', date: '2099-03-10' },
          orderKey: 'a0',
        },
      },
      plannedBlock: null,
      reminder: null,
      overdue: false,
    };
    const repeatAfterAction = vi.fn().mockResolvedValue(routineReceipt());
    const application = stubApplication({ getAction: () => Promise.resolve(workspace) });
    const user = userEvent.setup();
    render(
      <PlanningProvider planning={fakePlanning({ repeatAfterAction })} actions={application}>
        <MemoryRouter initialEntries={[`/actions/${intent.actionId}`]}>
          <Routes>
            <Route
              path="/actions/:actionId"
              element={<ActionDetailPage application={application} />}
            />
          </Routes>
        </MemoryRouter>
      </PlanningProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Repeat after this…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Repeat after this' });
    expect(dialog).toHaveAccessibleDescription(
      'This Action stays a one-off. A new Routine starts after it.',
    );
    const title = within(dialog).getByRole('textbox', { name: /Title/u });
    await waitFor(() => expect(title).toHaveFocus());
    expect(title).toHaveValue('Renew passport photos');
    expect(within(dialog).getByLabelText('Starts on')).toHaveValue('2099-03-11');
    await user.click(within(dialog).getByRole('button', { name: 'Create routine' }));
    await waitFor(() => expect(repeatAfterAction).toHaveBeenCalledTimes(1));
    expect(repeatAfterAction.mock.calls[0]?.[0]).toMatchObject({
      actionId: intent.actionId,
      title: 'Renew passport photos',
      rule: { kind: 'daily', intervalDays: 1, startsOn: '2099-03-11' },
      defaults: { estimateMinutes: 20, priority: 'high' },
    });
    expect(await screen.findByRole('link', { name: 'Open the new routine' })).toHaveAttribute(
      'href',
      '/plan/routines/40000000-0000-4000-8000-000000000001',
    );
  });
});

/* ───────────────────────── alignment: Milestones, triage, and cross-Axis confirmation ───────────── */

const axisA = '81000000-0000-4000-8000-000000000001' as UUID;
const axisB = '81000000-0000-4000-8000-000000000002' as UUID;
const projectInB = '82000000-0000-4000-8000-000000000001' as UUID;

function detailWorkspace(
  document: Partial<ActionCanonicalDocument> = {},
): ActionWorkspace & { readonly overdue: boolean } {
  return {
    action: {
      ref: {
        type: 'action',
        id: intent.actionId,
        ownerId: '50000000-0000-4000-8000-000000000001' as OwnerId,
      },
      localRevision: 7,
      serverRevision: 0,
      baseSnapshotHash: null,
      document: {
        title: 'Water the seedlings',
        captureOrigin: 'global_capture',
        orderKey: 'a0',
        state: 'planned',
        ...document,
      },
    },
    createdAt: '2026-09-20T10:00:00.000Z' as Instant,
    placement: null,
    plannedBlock: null,
    reminder: null,
    overdue: false,
  };
}

const crossAxisRejection: ApplicationResult<CommandReceipt> = {
  ok: false,
  error: {
    code: 'domain_rejected',
    domainError: {
      code: 'cross_axis_confirmation_required',
      message: 'This Action is in a different Axis than the Project. Confirm to link them.',
    },
  },
};

function renderDetail(application: ActionApplication, alignment?: AlignmentApplication): void {
  render(
    <PlanningProvider
      planning={fakePlanning({})}
      actions={application}
      {...(alignment === undefined ? {} : { alignment })}
    >
      <MemoryRouter initialEntries={[`/actions/${intent.actionId}`]}>
        <Routes>
          <Route
            path="/actions/:actionId"
            element={<ActionDetailPage application={application} />}
          />
        </Routes>
      </MemoryRouter>
    </PlanningProvider>,
  );
}

describe('crossAxisPending', () => {
  const noAxisProject = '82000000-0000-4000-8000-000000000002' as UUID;
  const projects = [
    { id: projectInB, title: 'Seed library', localRevision: 1, axisId: axisB },
    { id: noAxisProject, title: 'No Axis', localRevision: 1 },
  ];
  const unsaved = { axisId: '', projectId: '' };

  it('asks only for a new or changed pair whose Project names another Axis', () => {
    expect(crossAxisPending({ axisId: axisA, projectId: projectInB }, unsaved, projects)).toBe(
      true,
    );
    expect(crossAxisPending({ axisId: axisB, projectId: projectInB }, unsaved, projects)).toBe(
      false,
    );
    expect(
      crossAxisPending(
        { axisId: axisA, projectId: projectInB },
        { axisId: axisA, projectId: projectInB },
        projects,
      ),
    ).toBe(false);
    expect(crossAxisPending({ axisId: '', projectId: projectInB }, unsaved, projects)).toBe(false);
    expect(crossAxisPending({ axisId: axisA, projectId: noAxisProject }, unsaved, projects)).toBe(
      false,
    );
  });
});

describe('alignment Action detail: Milestones', () => {
  const actionNode = node('action', intent.actionId, 'Water the seedlings', { state: 'planned' });
  const actionNeighborhood: AlignmentNeighborhood = {
    focus: actionNode,
    chain: [],
    above: [edge('milestone_action', 'up', outline, { linkId: uuid(92), linkRevision: 5 })],
    below: [],
    totals: { milestone_action: 1 },
  };

  it('lists the Milestones an Action supports and unlinks one with both kept', async () => {
    const unlink = vi.fn().mockResolvedValue(receipt());
    const alignment = fakeAlignment({
      getNeighborhood: vi.fn().mockResolvedValue(actionNeighborhood),
      unlink,
    });
    const application = stubApplication({
      getAction: () => Promise.resolve(detailWorkspace()),
    });
    const user = userEvent.setup();
    renderDetail(application, alignment);

    const section = await screen.findByRole('region', { name: 'Milestones' });
    const list = await within(section).findByRole('list', {
      name: 'Milestones this Action supports',
    });
    expect(within(list).getByRole('link', { name: outline.title })).toHaveAttribute(
      'href',
      `/milestones/${outline.id}`,
    );
    expect(within(list).getByText('Active')).toBeVisible();
    await user.click(within(list).getByRole('button', { name: `Unlink… ${outline.title}` }));
    const dialog = await screen.findByRole('dialog', {
      name: `Unlink “Water the seedlings” from “${outline.title}”?`,
    });
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    expect(unlink).toHaveBeenCalledWith({
      relationship: 'milestone_action',
      linkId: uuid(92),
      revision: 5,
    });
  });

  it('links a milestone through the Milestone relationship only', async () => {
    const alignment = fakeAlignment({
      getNeighborhood: vi.fn().mockResolvedValue({ ...actionNeighborhood, above: [], totals: {} }),
      listLinkCandidates: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    });
    const application = stubApplication({
      getAction: () => Promise.resolve(detailWorkspace()),
    });
    const user = userEvent.setup();
    renderDetail(application, alignment);

    const section = await screen.findByRole('region', { name: 'Milestones' });
    expect(await within(section).findByText('Not linked to a milestone yet.')).toBeVisible();
    await user.click(within(section).getByRole('button', { name: 'Link a milestone…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link “Water the seedlings”' });
    expect(within(dialog).getByText('Link to: A Milestone it supports')).toBeVisible();
    expect(
      await within(dialog).findByText('Nothing to link yet. Create a Milestone first.'),
    ).toBeVisible();
  });

  it('shows no Milestones section without the alignment services', async () => {
    const application = stubApplication({
      getAction: () => Promise.resolve(detailWorkspace()),
    });
    renderDetail(application);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Water the seedlings' }),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Milestones' })).not.toBeInTheDocument();
  });
});

describe('Review Action permanent delete', () => {
  it('says review decisions stay in history, then deletes after the exact title', async () => {
    const deletePermanently = vi.fn().mockResolvedValue(routineReceipt());
    const application = stubApplication({
      getAction: () => Promise.resolve(detailWorkspace()),
      deletePermanently,
    });
    const user = userEvent.setup();
    renderDetail(application);

    await user.click(await screen.findByRole('button', { name: 'Delete permanently…' }));
    const dialog = screen.getByRole('dialog', { name: 'Permanently delete Action?' });
    expect(
      within(dialog).getByText('Review decisions about it stay in history as “Deleted object”.'),
    ).toBeVisible();
    const remove = within(dialog).getByRole('button', { name: 'Delete permanently' });
    expect(remove).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Action title' }), 'Water the');
    expect(remove).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Action title' }), ' seedlings');
    expect(remove).toBeEnabled();
    await user.click(remove);
    expect(deletePermanently).toHaveBeenCalledWith(intent.actionId, 7, 'Water the seedlings');
  });
});

describe('alignment cross-Axis confirmation', () => {
  const projects = [{ id: projectInB, title: 'Seed library', localRevision: 1, axisId: axisB }];
  const axes = [
    { id: axisA, title: 'Home', localRevision: 1 },
    { id: axisB, title: 'Community', localRevision: 1 },
  ];

  it('asks before saving an Action with a Project in another Axis', async () => {
    const edit = vi.fn().mockResolvedValue(routineReceipt());
    const application = stubApplication({
      getAction: () => Promise.resolve(detailWorkspace({ axisId: axisA })),
      listAxes: () => Promise.resolve(axes),
      listProjects: () => Promise.resolve(projects),
      edit,
    });
    const user = userEvent.setup();
    renderDetail(application);

    const project = await screen.findByRole('combobox', { name: 'Project' });
    await waitFor(() => expect(within(project).getAllByRole('option')).toHaveLength(2));
    expect(screen.queryByRole('checkbox', { name: 'Link across Axes' })).toBeNull();
    await user.selectOptions(project, projectInB);
    const confirm = screen.getByRole('checkbox', { name: 'Link across Axes' });
    expect(confirm).toHaveAccessibleDescription(/different Axis/u);
    await user.click(confirm);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(edit).toHaveBeenCalledWith(
      intent.actionId,
      7,
      expect.objectContaining({ axisId: axisA, projectId: projectInB, confirmCrossAxis: true }),
    );
  });

  it('shows the confirmation when the application asks for it, keeping the choice', async () => {
    const edit = vi
      .fn()
      .mockResolvedValueOnce(crossAxisRejection)
      .mockResolvedValue(routineReceipt());
    const application = stubApplication({
      getAction: () => Promise.resolve(detailWorkspace({ axisId: axisA })),
      listAxes: () => Promise.resolve(axes),
      listProjects: () =>
        Promise.resolve([{ id: projectInB, title: 'Seed library', localRevision: 1 }]),
      edit,
    });
    const user = userEvent.setup();
    renderDetail(application);

    const project = await screen.findByRole('combobox', { name: 'Project' });
    await waitFor(() => expect(within(project).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(project, projectInB);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Confirm to link them.');
    expect(project).toHaveValue(projectInB);
    await user.click(screen.getByRole('checkbox', { name: 'Link across Axes' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(edit).toHaveBeenLastCalledWith(
      intent.actionId,
      7,
      expect.objectContaining({ projectId: projectInB, confirmCrossAxis: true }),
    );
  });

  it('confirms a cross-Axis Project in capture before saving', async () => {
    const capture = vi.fn().mockResolvedValue(routineReceipt());
    const application = stubApplication({
      capture,
      listAxes: () => Promise.resolve(axes),
      listProjects: () => Promise.resolve(projects),
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <GlobalCapture application={application} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: /Capture Alt C/u }));
    await user.type(screen.getByRole('textbox', { name: /Title/u }), 'Label seed packets');
    await user.click(screen.getByText('More details'));
    const axis = screen.getByRole('combobox', { name: 'Axis' });
    await waitFor(() => expect(within(axis).getAllByRole('option')).toHaveLength(3));
    await user.selectOptions(axis, axisA);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), projectInB);
    await user.click(screen.getByRole('checkbox', { name: 'Link across Axes' }));
    await user.click(screen.getByRole('button', { name: /^Capture$/u }));
    expect(capture).toHaveBeenCalledWith(
      intent,
      expect.objectContaining({ axisId: axisA, projectId: projectInB, confirmCrossAxis: true }),
    );
  });
});

describe('alignment Inbox Plan with a Milestone', () => {
  const inboxItem = {
    id: intent.actionId,
    title: 'Water the seedlings',
    state: 'inbox' as const,
    sortKey: 'a0',
    localRevision: 2,
    createdAt: '2026-09-27T09:00:00.000Z' as Instant,
  };
  const milestoneChoice: MilestoneChoice = {
    id: outline.id,
    title: outline.title,
    localRevision: 4,
    outcomeId: guide.id,
    outcomeTitle: guide.title,
  };

  it('plans an Inbox Action and links it to a chosen Milestone', async () => {
    const triage = vi.fn().mockResolvedValue(routineReceipt());
    const application = stubApplication({
      listInbox: () => Promise.resolve({ items: [inboxItem], total: 1 }),
      listMilestones: () => Promise.resolve([milestoneChoice]),
      triage,
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InboxPage application={application} />
      </MemoryRouter>,
    );
    await user.click(await screen.findByText('Triage'));
    const panel = screen.getByText('Triage').closest('details') as HTMLElement;
    const milestone = await within(panel).findByRole('combobox', { name: 'Milestone' });
    expect(
      within(milestone)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['No milestone', `${outline.title} · ${guide.title}`]);
    await user.selectOptions(milestone, outline.id);
    await user.click(within(panel).getByRole('button', { name: 'Plan' }));
    expect(triage).toHaveBeenCalledWith(
      intent.actionId,
      2,
      expect.objectContaining({ kind: 'plan', milestoneId: outline.id }),
    );
  });

  it('hides the Milestone choice when there are no active Milestones', async () => {
    const application = stubApplication({
      listInbox: () => Promise.resolve({ items: [inboxItem], total: 1 }),
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InboxPage application={application} />
      </MemoryRouter>,
    );
    await user.click(await screen.findByText('Triage'));
    const panel = screen.getByText('Triage').closest('details') as HTMLElement;
    expect(within(panel).getByRole('combobox', { name: 'Project' })).toBeVisible();
    expect(within(panel).queryByRole('combobox', { name: 'Milestone' })).toBeNull();
  });

  it('asks to confirm a cross-Axis Project in triage, then sends the confirmation', async () => {
    const triage = vi
      .fn()
      .mockResolvedValueOnce(crossAxisRejection)
      .mockResolvedValue(routineReceipt());
    const application = stubApplication({
      listInbox: () => Promise.resolve({ items: [inboxItem], total: 1 }),
      listProjects: () =>
        Promise.resolve([{ id: projectInB, title: 'Seed library', localRevision: 1 }]),
      triage,
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InboxPage application={application} />
      </MemoryRouter>,
    );
    await user.click(await screen.findByText('Triage'));
    const panel = screen.getByText('Triage').closest('details') as HTMLElement;
    const project = within(panel).getByRole('combobox', { name: 'Project' });
    await waitFor(() => expect(within(project).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(project, projectInB);
    await user.click(within(panel).getByRole('button', { name: 'Plan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Confirm to link them.');
    await user.click(within(panel).getByRole('checkbox', { name: 'Link across Axes' }));
    await user.click(within(panel).getByRole('button', { name: 'Plan' }));
    expect(triage).toHaveBeenLastCalledWith(
      intent.actionId,
      2,
      expect.objectContaining({ kind: 'plan', projectId: projectInB, confirmCrossAxis: true }),
    );
  });

  it('asks to confirm a bulk Project change across Axes', async () => {
    const bulk = vi
      .fn()
      .mockResolvedValueOnce(crossAxisRejection)
      .mockResolvedValue(routineReceipt());
    const application = stubApplication({
      listInbox: () => Promise.resolve({ items: [inboxItem], total: 1 }),
      listProjects: () =>
        Promise.resolve([{ id: projectInB, title: 'Seed library', localRevision: 1 }]),
      bulk,
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InboxPage application={application} />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('checkbox', { name: 'Select Water the seedlings' }));
    const bar = screen.getByRole('region', { name: 'Bulk Inbox actions' });
    const project = within(bar).getByRole('combobox', { name: 'Project' });
    await waitFor(() => expect(within(project).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(project, projectInB);
    await user.click(within(bar).getByRole('button', { name: 'Apply Project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Confirm to link them.');
    await user.click(within(bar).getByRole('checkbox', { name: 'Link across Axes' }));
    await user.click(within(bar).getByRole('button', { name: 'Apply Project' }));
    expect(bulk).toHaveBeenLastCalledWith([{ id: intent.actionId, revision: 2 }], {
      kind: 'project',
      projectId: projectInB,
      confirmCrossAxis: true,
    });
  });
});

describe('Review Action detail: an unavailable Action', () => {
  it('has nothing unsaved, so leaving it asks nothing (a permanently deleted Action)', async () => {
    const application = stubApplication({ getAction: () => Promise.resolve(null) });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      renderDetail(application);
      await screen.findByText('This Action is unavailable.');
      const unload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(false);
      await userEvent.setup().click(screen.getByRole('link', { name: 'Return to Inbox' }));
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });
});
