// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

import type {
  AlignmentApplication,
  AlignmentNeighborhood,
  AlignmentNodeKind,
  AxisSummary,
  ProjectItem,
} from '@yelaxis/application';

import { fakePlanning, installDialogPolyfill } from '../plan/__fixtures__/c1-planning-fake';
import { alignmentPath } from '../plan/routes';
import {
  archivedShed,
  draft,
  edge,
  fakeAlignment,
  guide,
  home,
  milestoneNeighborhood,
  node,
  outcomeNeighborhood,
  outline,
  photos,
  receipt,
  renderAlignmentTree,
  secondGuide,
  uuid,
  water,
} from './__fixtures__/w3-alignment-fixtures';
import { AlignmentMap } from './alignment-map';
import { AlignmentPage } from './alignment-page';
import { relationshipLabel } from './labels';
import { RelationshipList, type AlignmentViewProps } from './relationship-list';

beforeAll(() => installDialogPolyfill());
afterEach(() => cleanup());

const route = '/axis/alignment';
const focusPath = (kind: AlignmentNodeKind, id: string, view?: 'map'): string =>
  `${route}?focus=${kind}:${id}${view === undefined ? '' : `&view=${view}`}`;

function neighborhoods(
  byKind: Partial<Record<AlignmentNodeKind, AlignmentNeighborhood | null>>,
): Mock<AlignmentApplication['getNeighborhood']> {
  return vi.fn<AlignmentApplication['getNeighborhood']>((focus) =>
    Promise.resolve(byKind[focus.kind] ?? null),
  );
}

const axisNeighborhood: AlignmentNeighborhood = {
  focus: home,
  chain: [],
  above: [],
  below: [edge('axis_outcome', 'down', guide)],
  totals: { axis_outcome: 1 },
};

const summaryText =
  'Outcome “Publish the garden guide”. Above: 1 Axis. Below: 2 Milestones, 2 Projects.';

function currentLocation(): string {
  return decodeURIComponent(screen.getByTestId('location').textContent ?? '');
}

describe('Alignment page: choosing where to start', () => {
  it('lists Axes and items outside any Axis when nothing is selected', async () => {
    const axis: AxisSummary = {
      id: home.id,
      localRevision: 1,
      title: home.title,
      state: 'active',
      orderKey: '000000001000000000',
      counts: { outcomes: 1, projects: 2, routines: 0 },
    };
    const project: ProjectItem = {
      id: photos.id,
      localRevision: 1,
      title: photos.title,
      state: 'idea',
      orderKey: '000000001000000000',
      nextAction: { status: 'not_applicable' },
    };
    const alignment = fakeAlignment({
      listAxes: vi.fn().mockResolvedValue({ items: [axis], total: 1 }),
      listUnassigned: vi.fn().mockResolvedValue({
        outcomes: { items: [], total: 0 },
        projects: { items: [project], total: 1 },
      }),
    });
    render(renderAlignmentTree(<AlignmentPage />, { alignment, path: route, route }));

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Choose where to start' }),
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Alignment' })).toBeVisible();
    const axes = screen.getByRole('list', { name: 'Axes' });
    expect(within(axes).getByRole('link', { name: home.title })).toHaveAttribute(
      'href',
      alignmentPath({ kind: 'axis', id: home.id }),
    );
    expect(within(axes).getByText('1 Outcome · 2 Projects · 0 Routines')).toBeVisible();
    const outside = screen.getByRole('list', { name: 'Not in an Axis' });
    expect(within(outside).getByRole('link', { name: photos.title })).toHaveAttribute(
      'href',
      alignmentPath({ kind: 'project', id: photos.id }),
    );
    expect(within(outside).getByText('Project · Idea')).toBeVisible();
  });

  it('moves focus to the selected heading after a choice from the picker', async () => {
    const axis: AxisSummary = {
      id: home.id,
      localRevision: 1,
      title: home.title,
      state: 'active',
      orderKey: '000000001000000000',
      counts: { outcomes: 1, projects: 0, routines: 0 },
    };
    const alignment = fakeAlignment({
      listAxes: vi.fn().mockResolvedValue({ items: [axis], total: 1 }),
      listUnassigned: vi.fn().mockResolvedValue({
        outcomes: { items: [], total: 0 },
        projects: { items: [], total: 0 },
      }),
      getNeighborhood: neighborhoods({ axis: axisNeighborhood }),
    });
    const user = userEvent.setup();
    render(renderAlignmentTree(<AlignmentPage />, { alignment, path: route, route }));
    const axes = await screen.findByRole('list', { name: 'Axes' });
    await user.click(within(axes).getByRole('link', { name: home.title }));
    const heading = await screen.findByRole('heading', {
      level: 2,
      name: `Selected: Axis ${home.title}`,
    });
    // The picker link is gone; focus must not be left on the page body.
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('points to Axis management when there are no Axes yet', async () => {
    const alignment = fakeAlignment({
      listAxes: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      listUnassigned: vi.fn().mockResolvedValue({
        outcomes: { items: [], total: 0 },
        projects: { items: [], total: 0 },
      }),
    });
    render(renderAlignmentTree(<AlignmentPage />, { alignment, path: route, route }));
    expect(await screen.findByText('No Axes yet.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to Axes' })).toHaveAttribute('href', '/axis');
  });
});

describe('Alignment page: safe states for deep links', () => {
  it('shows a calm unavailable state for a malformed focus without querying', async () => {
    const getNeighborhood = vi.fn();
    const alignment = fakeAlignment({ getNeighborhood });
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: `${route}?focus=outcome:not-an-id`,
        route,
      }),
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: 'This item is unavailable' }),
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Back to Axes' })).toHaveAttribute('href', '/axis');
    expect(getNeighborhood).not.toHaveBeenCalled();
  });

  it('shows the kind when a well-formed item is missing', async () => {
    const alignment = fakeAlignment({ getNeighborhood: neighborhoods({}) });
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: focusPath('outcome', uuid(999)),
        route,
      }),
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: 'This Outcome is unavailable' }),
    ).toBeVisible();
    expect(screen.getByText(/may have been deleted permanently/u)).toBeVisible();
  });

  it('offers Try again when the neighborhood cannot be read', async () => {
    const getNeighborhood = vi
      .fn()
      .mockRejectedValueOnce(new Error('worker busy'))
      .mockResolvedValue(outcomeNeighborhood());
    const alignment = fakeAlignment({ getNeighborhood });
    const user = userEvent.setup();
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: focusPath('outcome', guide.id),
        route,
      }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: `Selected: Outcome ${guide.title}` }),
    ).toBeVisible();
  });

  it('keeps an archived item readable, with links but without Link', async () => {
    const archived = { ...guide, state: 'archived', archived: true };
    const alignment = fakeAlignment({
      getNeighborhood: neighborhoods({ outcome: outcomeNeighborhood({ focus: archived }) }),
    });
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: focusPath('outcome', guide.id),
        route,
      }),
    );
    expect(await screen.findByText(/Archived\. Restore it on its page/u)).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Link…/u })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Unlink… ${archivedShed.title}` })).toBeVisible();
  });
});

describe('Alignment page: the relationship list', () => {
  it('renders the selected item, what is above it, and grouped children with words', async () => {
    const getNeighborhood = neighborhoods({ outcome: outcomeNeighborhood() });
    const alignment = fakeAlignment({ getNeighborhood });
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: focusPath('outcome', guide.id),
        route,
      }),
    );

    const heading = await screen.findByRole('heading', {
      level: 2,
      name: `Selected: Outcome ${guide.title}`,
    });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading).toHaveAccessibleDescription(summaryText);
    expect(getNeighborhood).toHaveBeenCalledWith({ kind: 'outcome', id: guide.id }, { limit: 50 });

    const views = within(screen.getByRole('group', { name: 'Show as' })).getAllByRole('radio');
    expect(views.map((radio) => radio.closest('label')?.textContent)).toEqual(['List', 'Map']);
    expect(views[0]).toBeChecked();

    const chain = screen.getByRole('navigation', { name: 'Alignment chain' });
    expect(within(chain).getByRole('link', { name: `Axis: ${home.title}` })).toHaveAttribute(
      'href',
      alignmentPath({ kind: 'axis', id: home.id }),
    );

    const list = screen.getByRole('region', { name: `Relationship list for ${guide.title}` });
    expect(list).toHaveAccessibleDescription(summaryText);
    const above = within(list).getByRole('list', { name: `Above ${guide.title}` });
    expect(within(above).getByRole('link', { name: home.title })).toHaveAttribute(
      'href',
      `/axis/${home.id}`,
    );
    expect(
      within(above).getByText(`Axis · ${relationshipLabel('axis_outcome', 'up')} · Active`),
    ).toBeVisible();

    const milestones = within(list).getByRole('list', {
      name: `Milestones below ${guide.title}`,
    });
    expect(within(milestones).getAllByRole('listitem')).toHaveLength(2);
    expect(
      within(milestones).getByRole('button', {
        name: `Move to another Outcome… ${outline.title}`,
      }),
    ).toBeVisible();
    expect(within(milestones).queryByRole('button', { name: /^Unlink/u })).toBeNull();
    expect(
      within(milestones).getByText(
        `Milestone · ${relationshipLabel('outcome_milestone', 'down')} · Completed`,
      ),
    ).toBeVisible();

    const supporting = within(list).getByRole('list', {
      name: `Supporting Projects below ${guide.title}`,
    });
    expect(
      within(supporting).getByText(
        `Project · ${relationshipLabel('outcome_secondary_project', 'down')} · Archived`,
      ),
    ).toBeVisible();
    expect(
      within(supporting).getByRole('button', { name: `Unlink… ${archivedShed.title}` }),
    ).toBeVisible();

    const panel = screen.getByRole('complementary', { name: 'Inspect' });
    expect(within(panel).getByText('1 of 2 milestones completed · 1 canceled')).toBeVisible();
    expect(within(panel).getByRole('link', { name: 'Open the Outcome page' })).toHaveAttribute(
      'href',
      `/outcomes/${guide.id}`,
    );
  });

  it('inspects a related item without re-centering, as a pressed toggle', async () => {
    const alignment = fakeAlignment({
      getNeighborhood: neighborhoods({ outcome: outcomeNeighborhood() }),
    });
    const user = userEvent.setup();
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: focusPath('outcome', guide.id),
        route,
      }),
    );
    const inspect = await screen.findByRole('button', { name: `Inspect ${photos.title}` });
    const inspectFocus = screen.getByRole('button', { name: `Inspect ${guide.title}` });
    expect(inspect).toHaveAttribute('aria-pressed', 'false');
    expect(inspectFocus).toHaveAttribute('aria-pressed', 'true');

    await user.click(inspect);
    expect(inspect).toHaveAttribute('aria-pressed', 'true');
    expect(inspectFocus).toHaveAttribute('aria-pressed', 'false');
    const panel = screen.getByRole('complementary', { name: 'Inspect' });
    expect(within(panel).getByText(photos.title)).toBeVisible();
    expect(within(panel).getByRole('link', { name: 'Open the Project page' })).toHaveAttribute(
      'href',
      `/projects/${photos.id}`,
    );
    expect(currentLocation()).toBe(focusPath('outcome', guide.id));

    await user.click(inspect);
    expect(inspect).toHaveAttribute('aria-pressed', 'false');
    expect(inspectFocus).toHaveAttribute('aria-pressed', 'true');
  });

  it('centers on a related item: pushes ?focus and moves focus to the new heading', async () => {
    const getNeighborhood = neighborhoods({
      outcome: outcomeNeighborhood(),
      axis: axisNeighborhood,
    });
    const alignment = fakeAlignment({ getNeighborhood });
    const user = userEvent.setup();
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: focusPath('outcome', guide.id),
        route,
      }),
    );
    await user.click(await screen.findByRole('button', { name: `Center ${home.title}` }));
    await waitFor(() => expect(currentLocation()).toBe(focusPath('axis', home.id)));
    const heading = await screen.findByRole('heading', {
      level: 2,
      name: `Selected: Axis ${home.title}`,
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText('Nothing above this Axis.')).toBeVisible();
  });

  it('loads every link of a truncated group with Show all', async () => {
    const truncated = outcomeNeighborhood({
      totals: { ...outcomeNeighborhood().totals, outcome_milestone: 60 },
    });
    const getNeighborhood = neighborhoods({ outcome: truncated });
    const alignment = fakeAlignment({ getNeighborhood });
    const user = userEvent.setup();
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: focusPath('outcome', guide.id),
        route,
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Show all 60 Milestones' }));
    await waitFor(() =>
      expect(getNeighborhood).toHaveBeenLastCalledWith(
        { kind: 'outcome', id: guide.id },
        { limit: 200 },
      ),
    );
    expect(await screen.findByText(/Showing 2 of 60\./u)).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Show all/u })).toBeNull();
  });
});

describe('Alignment page: the optional map', () => {
  it('switches to the map through the Show as choice, with a hidden decorative SVG', async () => {
    const alignment = fakeAlignment({
      getNeighborhood: neighborhoods({ outcome: outcomeNeighborhood() }),
    });
    const user = userEvent.setup();
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: focusPath('outcome', guide.id),
        route,
      }),
    );
    await user.click(await screen.findByRole('radio', { name: 'Map' }));
    await waitFor(() => expect(currentLocation()).toBe(focusPath('outcome', guide.id, 'map')));
    const map = screen.getByRole('region', { name: `Alignment map for ${guide.title}` });
    expect(map).toHaveAccessibleDescription(summaryText);
    const svg = map.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(
      within(map)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Above', 'Selected', 'Below']);
    const focusNode = within(map).getByRole('button', { name: `Inspect ${guide.title}` });
    expect(focusNode).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(map).getByRole('button', { name: `Inspect ${outline.title}` }));
    expect(within(map).getByRole('button', { name: `Inspect ${outline.title}` })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      within(screen.getByRole('complementary', { name: 'Inspect' })).getByText(outline.title),
    ).toBeVisible();
  });

  it('opens the map directly from ?view=map', async () => {
    const alignment = fakeAlignment({
      getNeighborhood: neighborhoods({ milestone: milestoneNeighborhood() }),
    });
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: focusPath('milestone', outline.id, 'map'),
        route,
      }),
    );
    expect(await screen.findByRole('radio', { name: 'Map' })).toBeChecked();
    expect(
      screen.getByRole('region', { name: `Alignment map for ${outline.title}` }),
    ).toBeVisible();
  });
});

describe('List and map parity', () => {
  function buttonNames(container: HTMLElement): string[] {
    return within(container)
      .getAllByRole('button')
      .map((button) => (button.textContent ?? '').replace(/\s+/gu, ' ').trim())
      .sort();
  }

  function parity(neighborhood: AlignmentNeighborhood, inspectedKey: string): void {
    const props: AlignmentViewProps = {
      neighborhood,
      inspectedKey,
      onOperation: vi.fn(),
      onShowAll: vi.fn(),
      summaryId: 'summary',
    };
    const list = render(
      <MemoryRouter>
        <RelationshipList {...props} />
      </MemoryRouter>,
    );
    const listNames = buttonNames(list.container);
    const listPressed = within(list.container)
      .getAllByRole('button', { pressed: true })
      .map((button) => button.textContent?.replace(/\s+/gu, ' ').trim());
    list.unmount();
    const map = render(
      <MemoryRouter>
        <AlignmentMap {...props} />
      </MemoryRouter>,
    );
    const mapNames = buttonNames(map.container);
    expect(mapNames).toEqual(listNames);
    for (const name of new Set(listNames))
      expect(within(map.container).getAllByRole('button', { name })).toHaveLength(
        listNames.filter((candidate) => candidate === name).length,
      );
    expect(
      within(map.container)
        .getAllByRole('button', { pressed: true })
        .map((button) => button.textContent?.replace(/\s+/gu, ' ').trim()),
    ).toEqual(listPressed);
    map.unmount();
  }

  it('offers the same named buttons for an Outcome neighborhood', () => {
    parity(outcomeNeighborhood(), `outcome:${guide.id}`);
  });

  it('offers the same named buttons for a Milestone neighborhood, with its required edge', () => {
    parity(milestoneNeighborhood(), `action:${water.id}`);
  });

  it('offers the same named buttons for truncated groups and archived nodes', () => {
    parity(
      outcomeNeighborhood({
        focus: { ...guide, archived: true, state: 'archived' },
        totals: { axis_outcome: 1, outcome_milestone: 90, outcome_primary_project: 1 },
      }),
      `project:${photos.id}`,
    );
  });
});

describe('Alignment page: link, unlink, and move from the list', () => {
  it('unlinks a supporting Project; both stay and Undo is offered', async () => {
    const unlink = vi.fn().mockResolvedValue(receipt());
    const undo = vi.fn().mockResolvedValue(receipt());
    const confirm = vi.spyOn(window, 'confirm');
    const alignment = fakeAlignment({
      getNeighborhood: neighborhoods({ outcome: outcomeNeighborhood() }),
      unlink,
    });
    const user = userEvent.setup();
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        planning: fakePlanning({ undo }),
        path: focusPath('outcome', guide.id),
        route,
      }),
    );
    await user.click(await screen.findByRole('button', { name: `Unlink… ${archivedShed.title}` }));
    const dialog = await screen.findByRole('dialog', {
      name: `Unlink “${archivedShed.title}” from “${guide.title}”?`,
    });
    expect(dialog).toHaveAccessibleDescription('Both stay; only this link is removed.');
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Keep link' })).toHaveFocus(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    expect(unlink).toHaveBeenCalledWith({
      relationship: 'outcome_secondary_project',
      linkId: uuid(90),
      revision: 2,
    });
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'));
    expect(
      await screen.findByText(`Unlinked “${archivedShed.title}” from “${guide.title}”. Both stay.`),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledWith(uuid(500));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('moves a Milestone to another Outcome instead of unlinking it', async () => {
    const reparentMilestone = vi.fn().mockResolvedValue(receipt());
    const alignment = fakeAlignment({
      getNeighborhood: neighborhoods({ outcome: outcomeNeighborhood() }),
      listChoices: vi.fn().mockResolvedValue([guide, secondGuide]),
      reparentMilestone,
    });
    const user = userEvent.setup();
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: focusPath('outcome', guide.id),
        route,
      }),
    );
    await user.click(
      await screen.findByRole('button', { name: `Move to another Outcome… ${outline.title}` }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: `Move “${outline.title}” to another Outcome`,
    });
    const select = await within(dialog).findByRole('combobox', { name: 'New Outcome' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose an Outcome', secondGuide.title]);
    await user.click(within(dialog).getByRole('button', { name: 'Move milestone' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Choose the Outcome to move it to.',
    );
    expect(select).toHaveFocus();
    await user.selectOptions(select, secondGuide.id);
    await user.click(within(dialog).getByRole('button', { name: 'Move milestone' }));
    expect(reparentMilestone).toHaveBeenCalledWith(
      { kind: 'milestone', id: outline.id, revision: 4 },
      secondGuide.id,
    );
    expect(
      await screen.findByText(`Moved “${outline.title}” to “${secondGuide.title}”.`),
    ).toBeInTheDocument();
  });

  it('links the selected item after previewing a replaced primary Outcome', async () => {
    const other = node('project', uuid(41), 'Label the seed boxes', { localRevision: 9 });
    const listLinkCandidates = vi.fn((input: { readonly relationship: string }): Promise<unknown> =>
      Promise.resolve(
        input.relationship === 'outcome_primary_project'
          ? {
              items: [
                { ...photos, alreadyLinked: true, crossAxis: false },
                { ...other, alreadyLinked: false, crossAxis: false },
              ],
              total: 2,
            }
          : { items: [], total: 0 },
      ),
    );
    // The application previews a replacement as allowed and names what it replaces.
    const previewLink = vi.fn().mockResolvedValue({
      allowed: true,
      alreadyLinked: false,
      replaces: secondGuide,
      crossAxis: false,
    });
    const link = vi.fn().mockResolvedValue(receipt());
    const alignment = fakeAlignment({
      getNeighborhood: neighborhoods({ outcome: outcomeNeighborhood() }),
      listLinkCandidates: listLinkCandidates as never,
      previewLink,
      link,
    });
    const user = userEvent.setup();
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: focusPath('outcome', guide.id),
        route,
      }),
    );
    await user.click(await screen.findByRole('button', { name: `Link… ${guide.title}` }));
    const dialog = await screen.findByRole('dialog', { name: `Link “${guide.title}”` });
    const options = within(within(dialog).getByRole('group', { name: 'Link to' })).getAllByRole(
      'radio',
    );
    expect(options.map((option) => option.closest('label')?.textContent)).toEqual([
      'Its Axis',
      'A Project with this primary Outcome',
      'A supporting Project',
    ]);
    await user.click(
      within(dialog).getByRole('radio', { name: 'A Project with this primary Outcome' }),
    );
    const linked = await within(dialog).findByRole('radio', { name: /Photograph the beds/u });
    expect(linked).toBeDisabled();
    expect(within(dialog).getByText('Active · Already linked')).toBeVisible();
    await user.click(within(dialog).getByRole('radio', { name: /Label the seed boxes/u }));
    expect(
      await within(dialog).findByText(`Replaces current primary Outcome “${secondGuide.title}”.`),
    ).toBeVisible();
    expect(previewLink).toHaveBeenCalledWith({
      relationship: 'outcome_primary_project',
      outcomeId: guide.id,
      project: { kind: 'project', id: other.id, revision: 9 },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Replace and link' }));
    expect(link).toHaveBeenCalledWith({
      relationship: 'outcome_primary_project',
      outcomeId: guide.id,
      project: { kind: 'project', id: other.id, revision: 9 },
      replaceExisting: true,
    });
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'));
  });
});

describe('Copy and motion audits', () => {
  it('uses no score, streak, assistant, or percentage-alignment wording', async () => {
    const alignment = fakeAlignment({
      getNeighborhood: neighborhoods({ outcome: outcomeNeighborhood() }),
    });
    const user = userEvent.setup();
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: focusPath('outcome', guide.id),
        route,
      }),
    );
    await screen.findByRole('heading', { name: `Selected: Outcome ${guide.title}` });
    const audit = (): void => {
      const text = document.body.textContent ?? '';
      expect(text).not.toMatch(/score|streak|aligned \d+%/iu);
      expect(text).not.toMatch(/\bAI\b/u);
    };
    audit();
    await user.click(screen.getByRole('radio', { name: 'Map' }));
    await screen.findByRole('region', { name: `Alignment map for ${guide.title}` });
    audit();
    expect(draft.state).toBe('completed');
  });

  it('draws the map without any scripted motion', async () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame');
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    const onOperation = vi.fn<AlignmentViewProps['onOperation']>();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AlignmentMap
          neighborhood={outcomeNeighborhood()}
          inspectedKey={`outcome:${guide.id}`}
          onOperation={onOperation}
          summaryId="summary"
        />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: `Inspect ${photos.title}` }));
    await user.click(screen.getByRole('button', { name: `Center ${photos.title}` }));
    expect(onOperation.mock.calls.map(([operation]) => operation)).toEqual(['inspect', 'center']);
    expect(frame).not.toHaveBeenCalled();
    expect(animate).not.toHaveBeenCalled();
    frame.mockRestore();
    Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  });
});
