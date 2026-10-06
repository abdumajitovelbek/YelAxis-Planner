// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  AlignmentApplication,
  AlignmentEdge,
  AlignmentNode,
  LinkPreview,
} from '@yelaxis/application';
import { alignmentRelationshipRules } from '@yelaxis/domain';

import { installDialogPolyfill } from '../plan/__fixtures__/c1-planning-fake';
import { CommandFeedback, useCommandRunner, type CommandRunner } from '../plan/planning-context';
import {
  edge,
  fakeAlignment,
  guide,
  home,
  node,
  outline,
  photos,
  receipt,
  rejected,
  renderAlignmentTree,
  secondGuide,
  uuid,
  water,
} from './__fixtures__/w3-alignment-fixtures';
import {
  buildLinkInput,
  buildUnlinkInput,
  LinkDialog,
  ReparentMilestoneDialog,
  UnlinkDialog,
} from './link-dialogs';

beforeAll(() => installDialogPolyfill());
afterEach(() => cleanup());

/** Opens a dialog from a real button, so focus return and the shared runner behave as in pages. */
function Opener({
  children,
  label,
}: {
  readonly label: string;
  readonly children: (open: boolean, close: () => void, runner: CommandRunner) => ReactNode;
}): ReactNode {
  const runner = useCommandRunner();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {label}
      </button>
      <CommandFeedback runner={runner} showError={!open} />
      {children(open, () => setOpen(false), runner)}
    </>
  );
}

function renderLink(
  alignment: AlignmentApplication,
  focus: AlignmentNode,
  relationships?: Parameters<typeof LinkDialog>[0]['relationships'],
): void {
  render(
    renderAlignmentTree(
      <Opener label="Open link">
        {(open, close, runner) => (
          <LinkDialog
            open={open}
            focus={focus}
            runner={runner}
            onClose={close}
            {...(relationships === undefined ? {} : { relationships })}
          />
        )}
      </Opener>,
      { alignment },
    ),
  );
}

const candidates = (
  items: readonly (AlignmentNode & {
    readonly alreadyLinked?: boolean;
    readonly crossAxis?: boolean;
  })[],
) =>
  vi.fn().mockResolvedValue({
    items: items.map((item) => ({ alreadyLinked: false, crossAxis: false, ...item })),
    total: items.length,
  });

const allowed = (overrides: Partial<LinkPreview> = {}): LinkPreview => ({
  allowed: true,
  alreadyLinked: false,
  crossAxis: false,
  ...overrides,
});

describe('buildLinkInput', () => {
  const rules = alignmentRelationshipRules;

  it('carries the child revision for single-valued links from either end', () => {
    expect(buildLinkInput(rules.axis_outcome, guide, home)).toEqual({
      relationship: 'axis_outcome',
      axisId: home.id,
      outcome: { kind: 'outcome', id: guide.id, revision: guide.localRevision },
    });
    expect(buildLinkInput(rules.axis_outcome, home, guide, { replaceExisting: true })).toEqual({
      relationship: 'axis_outcome',
      axisId: home.id,
      outcome: { kind: 'outcome', id: guide.id, revision: guide.localRevision },
      replaceExisting: true,
    });
    expect(buildLinkInput(rules.axis_project, photos, home)).toEqual({
      relationship: 'axis_project',
      axisId: home.id,
      project: { kind: 'project', id: photos.id, revision: 6 },
    });
    expect(buildLinkInput(rules.outcome_primary_project, guide, photos)).toEqual({
      relationship: 'outcome_primary_project',
      outcomeId: guide.id,
      project: { kind: 'project', id: photos.id, revision: 6 },
    });
    expect(
      buildLinkInput(rules.project_action, water, photos, {
        replaceExisting: true,
        confirmCrossAxis: true,
      }),
    ).toEqual({
      relationship: 'project_action',
      projectId: photos.id,
      action: { kind: 'action', id: water.id, revision: water.localRevision },
      replaceExisting: true,
      confirmCrossAxis: true,
    });
  });

  it('names both ends of join links and never adds confirmations they do not take', () => {
    expect(
      buildLinkInput(rules.outcome_secondary_project, photos, guide, { confirmCrossAxis: true }),
    ).toEqual({
      relationship: 'outcome_secondary_project',
      outcomeId: guide.id,
      projectId: photos.id,
    });
    expect(buildLinkInput(rules.milestone_project, outline, photos)).toEqual({
      relationship: 'milestone_project',
      milestoneId: outline.id,
      projectId: photos.id,
    });
    expect(buildLinkInput(rules.milestone_action, water, outline)).toEqual({
      relationship: 'milestone_action',
      milestoneId: outline.id,
      actionId: water.id,
    });
  });

  it('refuses display-only, required, and mismatched pairs', () => {
    expect(buildLinkInput(rules.axis_routine, home, node('routine', uuid(70), 'Tidy'))).toBeNull();
    expect(buildLinkInput(rules.project_note, photos, node('note', uuid(71), 'Seeds'))).toBeNull();
    expect(buildLinkInput(rules.outcome_milestone, guide, outline)).toBeNull();
    expect(buildLinkInput(rules.axis_outcome, outline, home)).toBeNull();
  });
});

describe('buildUnlinkInput', () => {
  it('unlinks foreign-key links through the child and its revision', () => {
    expect(buildUnlinkInput(photos, edge('axis_project', 'up', home))).toEqual({
      relationship: 'axis_project',
      project: { kind: 'project', id: photos.id, revision: 6 },
    });
    expect(buildUnlinkInput(home, edge('axis_outcome', 'down', guide))).toEqual({
      relationship: 'axis_outcome',
      outcome: { kind: 'outcome', id: guide.id, revision: guide.localRevision },
    });
    expect(buildUnlinkInput(guide, edge('outcome_primary_project', 'down', photos))).toEqual({
      relationship: 'outcome_primary_project',
      project: { kind: 'project', id: photos.id, revision: 6 },
    });
    expect(buildUnlinkInput(water, edge('project_action', 'up', photos))).toEqual({
      relationship: 'project_action',
      action: { kind: 'action', id: water.id, revision: water.localRevision },
    });
  });

  it('unlinks join links through the link record, and never a required link', () => {
    expect(
      buildUnlinkInput(
        outline,
        edge('milestone_action', 'down', water, { linkId: uuid(92), linkRevision: 5 }),
      ),
    ).toEqual({ relationship: 'milestone_action', linkId: uuid(92), revision: 5 });
    expect(buildUnlinkInput(outline, edge('milestone_project', 'down', photos))).toBeNull();
    expect(buildUnlinkInput(outline, edge('outcome_milestone', 'up', guide))).toBeNull();
    expect(
      buildUnlinkInput(home, edge('axis_routine', 'down', node('routine', uuid(72), 'Tidy'))),
    ).toBeNull();
  });
});

describe('LinkDialog', () => {
  it('links an Action to a Milestone when only that relationship is offered', async () => {
    const listLinkCandidates = candidates([outline]);
    const previewLink = vi.fn().mockResolvedValue(allowed());
    const link = vi.fn().mockResolvedValue(receipt());
    const alignment = fakeAlignment({ listLinkCandidates, previewLink, link });
    const user = userEvent.setup();
    renderLink(alignment, water, ['milestone_action']);

    const opener = screen.getByRole('button', { name: 'Open link' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: `Link “${water.title}”` });
    expect(within(dialog).queryByRole('group', { name: 'Link to' })).toBeNull();
    expect(within(dialog).getByText('Link to: A Milestone it supports')).toBeVisible();
    expect(
      within(dialog).getByText('Archived items are not listed. Restore one to link it.'),
    ).toBeVisible();
    await user.click(await within(dialog).findByRole('radio', { name: /Outline approved/u }));
    expect(listLinkCandidates).toHaveBeenCalledWith({
      focus: { kind: 'action', id: water.id },
      relationship: 'milestone_action',
      limit: 50,
    });
    expect(
      await within(dialog).findByText(`Links “${water.title}” to “${outline.title}”.`),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Link' }));
    expect(link).toHaveBeenCalledWith({
      relationship: 'milestone_action',
      milestoneId: outline.id,
      actionId: water.id,
    });
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'));
    expect(
      await screen.findByText(`Linked “${water.title}” to “${outline.title}”.`),
    ).toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('asks for an explicit cross-Axis confirmation before linking an Action to a Project', async () => {
    const listLinkCandidates = candidates([{ ...water, crossAxis: true }]);
    const previewLink = vi.fn().mockResolvedValue(allowed({ crossAxis: true }));
    const link = vi.fn().mockResolvedValue(receipt());
    const alignment = fakeAlignment({ listLinkCandidates, previewLink, link });
    const user = userEvent.setup();
    renderLink(alignment, photos, ['project_action']);

    await user.click(screen.getByRole('button', { name: 'Open link' }));
    const dialog = await screen.findByRole('dialog', { name: `Link “${photos.title}”` });
    await user.click(await within(dialog).findByRole('radio', { name: /Water the seedlings/u }));
    expect(within(dialog).getByText('Planned · In a different Axis')).toBeVisible();
    const confirmation = await within(dialog).findByRole('checkbox', { name: /Link across Axes/u });
    expect(confirmation).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Link' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Confirm “Link across Axes”, or choose another item.',
    );
    expect(confirmation).toHaveFocus();
    expect(link).not.toHaveBeenCalled();
    await user.click(confirmation);
    await user.click(within(dialog).getByRole('button', { name: 'Link' }));
    expect(link).toHaveBeenCalledWith({
      relationship: 'project_action',
      projectId: photos.id,
      action: { kind: 'action', id: water.id, revision: water.localRevision },
      confirmCrossAxis: true,
    });
  });

  it('explains a blocked link and never sends it', async () => {
    const listLinkCandidates = candidates([photos]);
    const previewLink = vi
      .fn()
      .mockResolvedValue(allowed({ allowed: false, reason: 'archived_endpoint' }));
    const link = vi.fn();
    const alignment = fakeAlignment({ listLinkCandidates, previewLink, link });
    const user = userEvent.setup();
    renderLink(alignment, outline, ['milestone_project']);

    await user.click(screen.getByRole('button', { name: 'Open link' }));
    const dialog = await screen.findByRole('dialog', { name: `Link “${outline.title}”` });
    await user.click(await within(dialog).findByRole('radio', { name: /Photograph the beds/u }));
    expect(
      await within(dialog).findByText('Restore the archived item before linking it.'),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Link' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Restore the archived item before linking it.',
    );
    expect(link).not.toHaveBeenCalled();
  });

  it('says Already linked when the preview finds an existing link, and sends nothing', async () => {
    const link = vi.fn();
    const alignment = fakeAlignment({
      listLinkCandidates: candidates([photos]),
      previewLink: vi.fn().mockResolvedValue(allowed({ alreadyLinked: true })),
      link,
    });
    const user = userEvent.setup();
    renderLink(alignment, outline, ['milestone_project']);

    await user.click(screen.getByRole('button', { name: 'Open link' }));
    const dialog = await screen.findByRole('dialog', { name: `Link “${outline.title}”` });
    await user.click(await within(dialog).findByRole('radio', { name: /Photograph the beds/u }));
    expect(await within(dialog).findByText('Already linked. Nothing changes.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Link' }));
    expect(link).not.toHaveBeenCalled();
  });

  it('asks for a choice first, searches by title, and says when nothing matches', async () => {
    const listLinkCandidates = vi.fn((input: { readonly search?: string }): Promise<unknown> =>
      Promise.resolve(
        input.search === undefined
          ? { items: [{ ...photos, alreadyLinked: false, crossAxis: false }], total: 80 }
          : { items: [], total: 0 },
      ),
    );
    const alignment = fakeAlignment({ listLinkCandidates: listLinkCandidates as never });
    const user = userEvent.setup();
    renderLink(alignment, outline, ['milestone_project']);

    await user.click(screen.getByRole('button', { name: 'Open link' }));
    const dialog = await screen.findByRole('dialog', { name: `Link “${outline.title}”` });
    expect(
      await within(dialog).findByText('Showing 1 of 80. Search by title to find others.'),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Link' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose a Project to link.');
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search by title' }), 'zz');
    expect(await within(dialog).findByText('Nothing matches “zz”.')).toBeVisible();
    expect(listLinkCandidates).toHaveBeenLastCalledWith({
      focus: { kind: 'milestone', id: outline.id },
      relationship: 'milestone_project',
      search: 'zz',
      limit: 50,
    });
  });

  it('keeps the dialog open with the reason when the command is refused', async () => {
    const alignment = fakeAlignment({
      listLinkCandidates: candidates([outline]),
      previewLink: vi.fn().mockResolvedValue(allowed()),
      link: vi.fn().mockResolvedValue(rejected('archived_endpoint', 'Restore it before linking.')),
    });
    const user = userEvent.setup();
    renderLink(alignment, water, ['milestone_action']);

    await user.click(screen.getByRole('button', { name: 'Open link' }));
    const dialog = await screen.findByRole('dialog', { name: `Link “${water.title}”` });
    await user.click(await within(dialog).findByRole('radio', { name: /Outline approved/u }));
    await within(dialog).findByText(`Links “${water.title}” to “${outline.title}”.`);
    await user.click(within(dialog).getByRole('button', { name: 'Link' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Restore it before linking.',
    );
    expect(dialog).toHaveAttribute('open');
  });

  it('says what to do for an archived focus instead of offering candidates', async () => {
    const listLinkCandidates = candidates([]);
    const alignment = fakeAlignment({ listLinkCandidates });
    const user = userEvent.setup();
    renderLink(alignment, { ...photos, state: 'archived', archived: true });

    await user.click(screen.getByRole('button', { name: 'Open link' }));
    const dialog = await screen.findByRole('dialog', { name: `Link “${photos.title}”` });
    expect(within(dialog).getByText('Restore this Project before linking it.')).toBeVisible();
    expect(within(dialog).queryByRole('radio')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'));
  });

  it('reports candidates that cannot be loaded', async () => {
    const alignment = fakeAlignment({
      listLinkCandidates: vi.fn().mockRejectedValue(new Error('worker busy')),
    });
    const user = userEvent.setup();
    renderLink(alignment, outline, ['milestone_action']);
    await user.click(screen.getByRole('button', { name: 'Open link' }));
    const dialog = await screen.findByRole('dialog', { name: `Link “${outline.title}”` });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'These items could not be loaded.',
    );
  });
});

describe('UnlinkDialog and ReparentMilestoneDialog', () => {
  it('unlinks a Project from its Axis through the Project revision', async () => {
    const unlink = vi.fn().mockResolvedValue(receipt());
    const alignment = fakeAlignment({ unlink });
    const axisEdge: AlignmentEdge = edge('axis_project', 'up', home);
    const user = userEvent.setup();
    render(
      renderAlignmentTree(
        <Opener label="Open unlink">
          {(open, close, runner) => (
            <UnlinkDialog
              open={open}
              focus={photos}
              edge={axisEdge}
              runner={runner}
              onClose={close}
            />
          )}
        </Opener>,
        { alignment },
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Open unlink' }));
    const dialog = await screen.findByRole('dialog', {
      name: `Unlink “${photos.title}” from “${home.title}”?`,
    });
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    expect(unlink).toHaveBeenCalledWith({
      relationship: 'axis_project',
      project: { kind: 'project', id: photos.id, revision: 6 },
    });
    expect(
      await screen.findByText(`Unlinked “${photos.title}” from “${home.title}”. Both stay.`),
    ).toBeInTheDocument();
  });

  it('keeps Keep link as the safe default and closes without a change', async () => {
    const unlink = vi.fn();
    const alignment = fakeAlignment({ unlink });
    const user = userEvent.setup();
    render(
      renderAlignmentTree(
        <Opener label="Open unlink">
          {(open, close, runner) => (
            <UnlinkDialog
              open={open}
              focus={outline}
              edge={edge('milestone_action', 'down', water, { linkId: uuid(92), linkRevision: 5 })}
              runner={runner}
              onClose={close}
            />
          )}
        </Opener>,
        { alignment },
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Open unlink' }));
    const dialog = await screen.findByRole('dialog', {
      name: `Unlink “${water.title}” from “${outline.title}”?`,
    });
    const keep = within(dialog).getByRole('button', { name: 'Keep link' });
    await waitFor(() => expect(keep).toHaveFocus());
    await user.click(keep);
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'));
    expect(unlink).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open unlink' })).toHaveFocus();
  });

  it('explains when there is no other Outcome to move a Milestone to', async () => {
    const alignment = fakeAlignment({ listChoices: vi.fn().mockResolvedValue([guide]) });
    const user = userEvent.setup();
    render(
      renderAlignmentTree(
        <Opener label="Open move">
          {(open, close, runner) => (
            <ReparentMilestoneDialog
              open={open}
              milestone={{
                kind: 'milestone',
                id: outline.id,
                revision: 4,
                title: outline.title,
                outcomeId: guide.id,
              }}
              runner={runner}
              onClose={close}
            />
          )}
        </Opener>,
        { alignment },
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Open move' }));
    const dialog = await screen.findByRole('dialog', {
      name: `Move “${outline.title}” to another Outcome`,
    });
    expect(
      await within(dialog).findByText(
        'There is no other Outcome yet. Create one first, then move this milestone.',
      ),
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Move milestone' })).toBeDisabled();
    expect(secondGuide.kind).toBe('outcome');
  });
});
