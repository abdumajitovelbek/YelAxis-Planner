// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  AlignmentApplication,
  CommandReceipt,
  OutcomeDetail,
  PlanningApplication,
} from '@yelaxis/application';

import { installDialogPolyfill } from '../plan/__fixtures__/c1-planning-fake';
import { lastProps, resetStandIns, wasRendered } from './__fixtures__/detail-dialog-mocks';
import {
  fakeAlignment,
  forbiddenCopy,
  ids,
  outcomeDetail,
  outcomeItem,
  planningFake,
  receipt,
  renderDetail,
} from './__fixtures__/detail-fixtures';
import { OutcomeDetailPage } from './outcome-detail';

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

function renderOutcome(
  options: {
    readonly detail?: OutcomeDetail | null;
    readonly getOutcome?: AlignmentApplication['getOutcome'];
    readonly alignment?: Partial<AlignmentApplication>;
    readonly planning?: Partial<PlanningApplication>;
    readonly path?: string;
  } = {},
) {
  const getOutcome =
    options.getOutcome ??
    vi.fn().mockResolvedValue(options.detail === undefined ? outcomeDetail() : options.detail);
  const alignment = fakeAlignment({ getOutcome, ...options.alignment });
  renderDetail({
    path: options.path ?? `/outcomes/${ids.outcome}`,
    route: '/outcomes/:outcomeId',
    element: <OutcomeDetailPage />,
    alignment,
    planning: planningFake(options.planning),
  });
  return { getOutcome };
}

const title = async (): Promise<HTMLElement> =>
  screen.findByRole('heading', { level: 1, name: 'Finish the manuscript' });

describe('Outcome detail page', () => {
  it('shows the facts, progress, Milestones, Projects, and history under one h1', async () => {
    const { getOutcome } = renderOutcome();
    expect(await title()).toBeVisible();
    expect(getOutcome).toHaveBeenCalledWith(ids.outcome);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Outcome · Active')).toBeVisible();
    expect(screen.getByText('The manuscript is with the editor')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Craft' })).toHaveAttribute(
      'href',
      `/axis/${ids.axis}`,
    );
    expect(screen.getByText('Target Aug 1, 2026 – Dec 18, 2026')).toBeVisible();
    expect(screen.getByRole('link', { name: 'August 2026' })).toHaveAttribute(
      'href',
      '/plan/month/2026-08-01',
    );
    expect(lastProps('ProgressEditor')['outcome']).toMatchObject({ id: ids.outcome });

    const milestones = within(
      screen.getByRole('list', { name: 'Milestones of Finish the manuscript' }),
    ).getAllByRole('listitem');
    expect(milestones).toHaveLength(2);
    expect(
      within(milestones[0] as HTMLElement).getByRole('link', { name: 'Draft chapter two' }),
    ).toHaveAttribute('href', `/milestones/${ids.milestone}`);
    expect(milestones[0]).toHaveTextContent('Active');
    expect(milestones[1]).toHaveTextContent('Revise chapter two');
    expect(milestones[1]).toHaveTextContent('Completed');

    expect(
      within(
        screen.getByRole('list', {
          name: 'Projects with Finish the manuscript as their primary Outcome',
        }),
      ).getByRole('link', { name: 'Research notes' }),
    ).toHaveAttribute('href', `/projects/${ids.project}`);
    expect(
      within(
        screen.getByRole('list', { name: 'Projects that also support Finish the manuscript' }),
      ).getByRole('link', { name: 'Workshop feedback' }),
    ).toHaveAttribute('href', `/projects/${ids.projectTwo}`);

    const history = screen.getByRole('region', { name: 'History' });
    expect(history).toHaveTextContent('Link added');
    expect(history).toHaveTextContent('Created');
    expect(document.body.textContent).not.toMatch(forbiddenCopy);

    expect(lastProps('DangerZone')).toMatchObject({
      target: { kind: 'outcome', id: ids.outcome, revision: 4, title: 'Finish the manuscript' },
      parentPath: `/axis/${ids.axis}`,
    });
    const danger = screen.getByTestId('danger-zone');
    expect(history.compareDocumentPosition(danger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers the state changes of the current state and announces each with Undo', async () => {
    const user = userEvent.setup();
    const transitionOutcome = vi.fn().mockResolvedValue(receipt());
    renderOutcome({ alignment: { transitionOutcome } });
    await title();
    const actions = screen.getByRole('group', { name: 'Outcome actions' });
    expect(within(actions).getByRole('button', { name: 'Mark achieved' })).toBeVisible();
    expect(within(actions).getByRole('button', { name: 'Abandon' })).toBeVisible();
    expect(within(actions).queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    expect(within(actions).queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();

    await user.click(within(actions).getByRole('button', { name: 'Pause' }));
    expect(transitionOutcome).toHaveBeenCalledWith(
      { kind: 'outcome', id: ids.outcome, revision: 4 },
      'paused',
    );
    expect(await screen.findByText('Outcome paused.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  it('keeps buttons focusable but inert while a change is saving', async () => {
    const user = userEvent.setup();
    let finish: (value: Awaited<ReturnType<typeof receipt>>) => void = () => undefined;
    const transitionOutcome = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof receipt>>>((resolve) => {
          finish = resolve;
        }),
    );
    renderOutcome({ alignment: { transitionOutcome } });
    await title();
    const actions = screen.getByRole('group', { name: 'Outcome actions' });
    const pause = within(actions).getByRole('button', { name: 'Pause' });
    await user.click(pause);
    const achieve = within(actions).getByRole('button', { name: 'Mark achieved' });
    expect(achieve).toHaveAttribute('aria-disabled', 'true');
    expect(pause).toHaveFocus();
    await user.click(achieve);
    expect(transitionOutcome).toHaveBeenCalledTimes(1);
    act(() => finish(receipt()));
    expect(await screen.findByText('Outcome paused.')).toBeInTheDocument();
  });

  it('reactivates a finished Outcome and says calmly that abandoning is valid', async () => {
    renderOutcome({ detail: outcomeDetail({ outcome: outcomeItem({ state: 'abandoned' }) }) });
    await title();
    expect(screen.getByText('Outcome · Abandoned')).toBeVisible();
    expect(
      screen.getByText(
        'Abandoning is a valid decision. The Outcome and its history stay in reviews.',
      ),
    ).toBeVisible();
    const actions = screen.getByRole('group', { name: 'Outcome actions' });
    expect(within(actions).getByRole('button', { name: 'Reactivate' })).toBeVisible();
    expect(within(actions).queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(within(actions).queryByRole('button', { name: 'Abandon' })).not.toBeInTheDocument();
  });

  it('reorders Milestones inside the Outcome from the keyboard', async () => {
    const user = userEvent.setup();
    const reorder = vi.fn().mockResolvedValue(receipt());
    renderOutcome({ alignment: { reorder } });
    const list = await screen.findByRole('list', { name: 'Milestones of Finish the manuscript' });
    const [first] = within(list).getAllByRole('listitem');
    within(first as HTMLElement)
      .getByRole('button', { name: /down/iu })
      .focus();
    await user.keyboard('{Enter}');
    expect(reorder).toHaveBeenCalledWith({
      target: { kind: 'milestone', id: ids.milestone, revision: 3 },
      direction: 'down',
      scope: { container: 'outcome_milestones', outcomeId: ids.outcome },
    });
    expect(await screen.findByText('Moved “Draft chapter two” down.')).toBeInTheDocument();
  });

  it('opens the shared forms with this Outcome and its presets', async () => {
    const user = userEvent.setup();
    renderOutcome();
    await title();
    await user.click(screen.getByRole('button', { name: 'Edit…' }));
    expect(screen.getByRole('dialog', { name: 'OutcomeFormDialog' })).toBeVisible();
    expect(lastProps('OutcomeFormDialog')).toMatchObject({
      open: true,
      mode: 'edit',
      initial: { id: ids.outcome, localRevision: 4 },
    });
    await user.click(screen.getByRole('button', { name: 'Close OutcomeFormDialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add milestone…' }));
    expect(lastProps('MilestoneFormDialog')).toMatchObject({
      open: true,
      mode: 'create',
      preset: { outcomeId: ids.outcome, outcomeTitle: 'Finish the manuscript' },
    });
    await user.click(screen.getByRole('button', { name: 'Close MilestoneFormDialog' }));

    await user.click(screen.getByRole('button', { name: 'Add project…' }));
    expect(lastProps('ProjectFormDialog')).toMatchObject({
      open: true,
      mode: 'create',
      preset: { primaryOutcomeId: ids.outcome, axisId: ids.axis },
    });
    await user.click(screen.getByRole('button', { name: 'Close ProjectFormDialog' }));

    await user.click(screen.getByRole('button', { name: 'Archive…' }));
    expect(lastProps('ArchiveDialog')).toMatchObject({
      open: true,
      target: { kind: 'outcome', id: ids.outcome, revision: 4, title: 'Finish the manuscript' },
    });
  });

  it('opens a Project created here on its own page with the confirmation', async () => {
    const user = userEvent.setup();
    renderOutcome();
    await title();
    await user.click(screen.getByRole('button', { name: 'Add project…' }));
    const onSaved = lastProps('ProjectFormDialog')['onSaved'] as (
      id: string,
      receipt: CommandReceipt | null,
    ) => void;
    act(() => onSaved(ids.projectTwo, null));
    expect(await screen.findByTestId('location')).toHaveTextContent(`/projects/${ids.projectTwo}`);
  });

  it('links and unlinks Projects through the shared dialogs', async () => {
    const user = userEvent.setup();
    renderOutcome();
    await title();
    await user.click(screen.getByRole('button', { name: 'Link a project…' }));
    expect(lastProps('LinkDialog')).toMatchObject({
      open: true,
      focus: { kind: 'outcome', id: ids.outcome, localRevision: 4, archived: false },
      relationships: ['outcome_primary_project', 'outcome_secondary_project'],
    });
    await user.click(screen.getByRole('button', { name: 'Close LinkDialog' }));

    await user.click(screen.getByRole('button', { name: 'Unlink… Research notes' }));
    expect(lastProps('UnlinkDialog')).toMatchObject({
      open: true,
      focus: { kind: 'outcome', id: ids.outcome },
      edge: {
        relationship: 'outcome_primary_project',
        direction: 'down',
        required: false,
        other: { kind: 'project', id: ids.project, localRevision: 5 },
      },
    });
    expect(lastProps('UnlinkDialog')['edge']).not.toHaveProperty('linkId');
    await user.click(screen.getByRole('button', { name: 'Close UnlinkDialog' }));

    await user.click(screen.getByRole('button', { name: 'Unlink… Workshop feedback' }));
    expect(lastProps('UnlinkDialog')).toMatchObject({
      open: true,
      edge: {
        relationship: 'outcome_secondary_project',
        direction: 'down',
        linkId: ids.link,
        linkRevision: 1,
        other: { kind: 'project', id: ids.projectTwo },
      },
    });
  });

  it('places the Outcome in a year or a month only, and removes the placement', async () => {
    const user = userEvent.setup();
    const place = vi.fn().mockResolvedValue(receipt());
    const unplace = vi.fn().mockResolvedValue(receipt());
    renderOutcome({ planning: { place, unplace } });
    await title();
    const opener = screen.getByRole('button', { name: 'Place in year or month…' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Place “Finish the manuscript”' });
    expect(within(dialog).getByRole('radio', { name: 'A month' })).toBeChecked();
    expect(within(dialog).getByLabelText('Month')).toHaveValue('2026-08');
    expect(within(dialog).queryByRole('radio', { name: 'A week' })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(opener).toHaveFocus();

    await user.click(opener);
    const again = await screen.findByRole('dialog', { name: 'Place “Finish the manuscript”' });
    await user.click(within(again).getByRole('radio', { name: 'A year' }));
    await user.selectOptions(within(again).getByLabelText('Year'), '2027');
    expect(within(again).getByRole('status')).toHaveTextContent(
      '“Finish the manuscript” will be placed in 2027.',
    );
    await user.click(within(again).getByRole('button', { name: 'Place' }));
    expect(place).toHaveBeenCalledWith({
      target: { kind: 'outcome', id: ids.outcome, revision: 4 },
      period: { kind: 'year', date: '2027-01-01' },
    });
    expect(await screen.findByText('Placed in 2027.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Remove placement' }));
    expect(unplace).toHaveBeenCalledWith({
      target: { kind: 'outcome', id: ids.outcome, revision: 4 },
    });
    expect(await screen.findByText('Placement removed.')).toBeInTheDocument();
  });

  it('keeps an archived Outcome read-only with Restore', async () => {
    renderOutcome({
      detail: outcomeDetail({
        outcome: outcomeItem({ state: 'archived', stateBeforeArchive: 'active' }),
      }),
    });
    await title();
    expect(screen.getByText('Archived. Restore it to make changes.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeVisible();
    expect(lastProps('ArchivedNotice')['target']).toEqual({
      kind: 'outcome',
      id: ids.outcome,
      revision: 4,
      title: 'Finish the manuscript',
    });
    expect(screen.queryByRole('group', { name: 'Outcome actions' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /move|unlink|link a|add /iu }),
    ).not.toBeInTheDocument();
    // The progress section stays visible; the shared editor itself is read-only when archived.
    expect(lastProps('ProgressEditor')['outcome']).toMatchObject({ state: 'archived' });
    expect(wasRendered('DangerZone')).toBe(true);
    expect(screen.getByTestId('danger-zone')).toBeInTheDocument();
  });

  it('shows the unavailable state for a malformed id without reading', async () => {
    const getOutcome = vi.fn();
    renderOutcome({ getOutcome, path: '/outcomes/not-an-outcome' });
    expect(
      await screen.findByRole('heading', { level: 1, name: /this outcome is unavailable/iu }),
    ).toBeVisible();
    expect(getOutcome).not.toHaveBeenCalled();
  });

  it('shows the unavailable state for a missing Outcome', async () => {
    renderOutcome({ detail: null });
    expect(
      await screen.findByRole('heading', { level: 1, name: /this outcome is unavailable/iu }),
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('recovers from a read error with Try again', async () => {
    const user = userEvent.setup();
    const getOutcome = vi
      .fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(outcomeDetail());
    renderOutcome({ getOutcome });
    expect(await screen.findByRole('alert')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await title()).toBeVisible();
  });
});
