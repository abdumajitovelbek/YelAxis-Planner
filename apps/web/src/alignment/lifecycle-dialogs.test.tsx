// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { Route } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AlignmentApplication, DeleteImpactView } from '@yelaxis/application';
import type { PermanentDeletePolicy } from '@yelaxis/domain';

import { CommandFeedback, useCommandRunner } from '../plan/planning-context';
import {
  alignmentNode,
  alignmentTree,
  archiveImpact,
  bounded,
  deleteImpact,
  fakeAlignment,
  ids,
  installDialogPolyfill,
  receipt,
  rejected,
} from './__fixtures__/alignment-fake';
import {
  ArchiveDialog,
  ArchivedNotice,
  DangerZone,
  deleteBlockerMessages,
  keptReviewsText,
} from './lifecycle-dialogs';

beforeAll(installDialogPolyfill);
afterEach(() => cleanup());

const outcomeTarget = {
  kind: 'outcome' as const,
  id: ids.halfMarathon,
  revision: 2,
  title: 'Run a half marathon',
};
const axisTarget = { kind: 'axis' as const, id: ids.health, revision: 3, title: 'Health' };

function ArchiveHarness(): ReactNode {
  const runner = useCommandRunner();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Archive…
      </button>
      <ArchiveDialog
        open={open}
        target={outcomeTarget}
        runner={runner}
        onClose={() => setOpen(false)}
      />
      <CommandFeedback runner={runner} />
    </>
  );
}

describe('ArchiveDialog', () => {
  it('states the consequences in words and archives with undo', async () => {
    const user = userEvent.setup();
    const archive = vi.fn(() => Promise.resolve(receipt()));
    const previewArchive = vi.fn(() => Promise.resolve(archiveImpact()));
    render(alignmentTree(fakeAlignment({ archive, previewArchive }), <ArchiveHarness />));
    await user.click(screen.getByRole('button', { name: 'Archive…' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive this Outcome?' });
    expect(
      await within(dialog).findByText(
        '1 Project and 2 Milestones stay as they are and show that their Outcome is archived.',
      ),
    ).toBeVisible();
    expect(within(dialog).getByText(/Its place on the plan is kept/u)).toBeVisible();
    expect(within(dialog).getByText(/Nothing is deleted/u)).toBeVisible();
    expect(previewArchive).toHaveBeenCalledWith({ kind: 'outcome', id: ids.halfMarathon });
    await user.click(within(dialog).getByRole('button', { name: 'Archive Outcome' }));
    await waitFor(() =>
      expect(archive).toHaveBeenCalledWith({ kind: 'outcome', id: ids.halfMarathon, revision: 2 }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Archive…' })).toHaveFocus();
  });

  it('keeps the dialog open with the reason when archiving fails', async () => {
    const user = userEvent.setup();
    const archive = vi.fn(() =>
      Promise.resolve(
        rejected({ code: 'invalid_transition', message: 'This Outcome is already archived.' }),
      ),
    );
    render(
      alignmentTree(
        fakeAlignment({ archive, previewArchive: () => Promise.resolve(archiveImpact()) }),
        <ArchiveHarness />,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Archive…' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive this Outcome?' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive Outcome' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This Outcome is already archived.',
    );
  });
});

describe('ArchivedNotice', () => {
  it('explains the read-only state and restores', async () => {
    const user = userEvent.setup();
    const restore = vi.fn(() => Promise.resolve(receipt()));
    function Notice(): ReactNode {
      const runner = useCommandRunner();
      return (
        <>
          <ArchivedNotice target={outcomeTarget} runner={runner} />
          <CommandFeedback runner={runner} />
        </>
      );
    }
    render(alignmentTree(fakeAlignment({ restore }), <Notice />));
    expect(screen.getByText('Archived. Restore it to make changes.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(restore).toHaveBeenCalledWith({ kind: 'outcome', id: ids.halfMarathon, revision: 2 }),
    );
    expect(await screen.findByText('Outcome restored.')).toBeInTheDocument();
  });
});

function DangerHarness({
  target = axisTarget,
}: {
  readonly target?: typeof axisTarget | typeof outcomeTarget;
}): ReactNode {
  const runner = useCommandRunner();
  return <DangerZone target={target} parentPath="/axis" runner={runner} />;
}

function renderDanger(alignment: AlignmentApplication, target?: typeof outcomeTarget) {
  return render(
    alignmentTree(alignment, <DangerHarness {...(target === undefined ? {} : { target })} />, {
      path: '/axis/current',
      route: '/axis/current',
      notice: true,
      extraRoutes: <Route path="/axis" element={<h1>Axes</h1>} />,
    }),
  );
}

describe('DangerZone and DeleteDialog', () => {
  it('explains a blocked delete and offers no way forward', async () => {
    const user = userEvent.setup();
    const previewDelete = vi.fn(() =>
      Promise.resolve(
        deleteImpact({
          target: alignmentNode('outcome', ids.halfMarathon, 'Run a half marathon'),
          allowed: false,
          blockers: ['required_children'],
          requiredChildren: bounded(
            [
              { kind: 'milestone', id: ids.baseMiles, title: 'Base miles', archived: false },
              { kind: 'milestone', id: ids.raceDay, title: 'Race day', archived: true },
            ],
            3,
          ),
          confirmationText: 'Run a half marathon',
        }),
      ),
    );
    renderDanger(fakeAlignment({ previewDelete }), outcomeTarget);
    expect(screen.getByRole('heading', { level: 2, name: 'Permanent deletion' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete permanently…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this Outcome permanently?' });
    expect(
      await within(dialog).findByText(
        'This Outcome still owns 3 milestones. Move or delete each one first.',
      ),
    ).toBeVisible();
    const children = within(dialog).getByRole('list', { name: 'Milestones of this Outcome' });
    expect(children).toHaveTextContent('Milestone “Base miles”');
    expect(children).toHaveTextContent('Milestone “Race day” (archived)');
    expect(children).toHaveTextContent('and 1 more');
    expect(within(dialog).queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(previewDelete).toHaveBeenCalledWith(
      { kind: 'outcome', id: ids.halfMarathon },
      'restrict',
    );
  });

  it('previews exactly what an explicit unlink removes, then asks for the exact title', async () => {
    const user = userEvent.setup();
    const linked: DeleteImpactView['optionalLinks'] = bounded([
      {
        kind: 'outcome',
        id: ids.halfMarathon,
        title: 'Run a half marathon',
        relationship: 'axis_outcome',
        archived: false,
      },
    ]);
    const previewDelete = vi.fn((_target: unknown, policy: PermanentDeletePolicy) =>
      Promise.resolve(
        deleteImpact({
          policy,
          allowed: policy === 'unlink_and_delete',
          blockers: policy === 'restrict' ? ['live_optional_relationships'] : [],
          optionalLinks: linked,
          removedHistory: { inactiveLinks: 2, archivedPlacements: 0, archivedSelections: 1 },
        }),
      ),
    );
    const deletePermanently = vi.fn(() => Promise.resolve(receipt(undefined, { undo: false })));
    renderDanger(fakeAlignment({ previewDelete, deletePermanently }));
    await user.click(screen.getByRole('button', { name: 'Delete permanently…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this Axis permanently?' });
    expect(await within(dialog).findByText(/still linked or placed/u)).toBeVisible();
    expect(within(dialog).getByRole('list', { name: 'Linked items' })).toHaveTextContent(
      'Outcome “Run a half marathon” · Outcome in this Axis',
    );
    expect(
      within(dialog).getByText(
        'Its own history is removed with it: 2 former links, 1 archived week selection. Nothing else is removed.',
      ),
    ).toBeVisible();
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'Also remove optional links and placements' }),
    );
    expect(
      await within(dialog).findByText(
        'These links and placements will be removed. No other items are deleted.',
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(previewDelete).toHaveBeenLastCalledWith(
        { kind: 'axis', id: ids.health },
        'unlink_and_delete',
      ),
    );
    await user.click(await within(dialog).findByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByText('This cannot be undone.')).toBeVisible();
    const confirm = within(dialog).getByLabelText('Type the Axis title to confirm');
    await waitFor(() => expect(confirm).toHaveFocus());
    const remove = within(dialog).getByRole('button', { name: 'Delete permanently' });
    expect(remove).toBeDisabled();
    expect(remove).not.toHaveClass('primary-button');
    await user.type(confirm, 'health');
    expect(remove).toBeDisabled();
    await user.clear(confirm);
    await user.type(confirm, 'Health');
    expect(remove).toBeEnabled();
    await user.click(remove);
    await waitFor(() =>
      expect(deletePermanently).toHaveBeenCalledWith({
        target: { kind: 'axis', id: ids.health, revision: 3 },
        policy: 'unlink_and_delete',
        confirmation: 'Health',
      }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Axes' })).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('/axis');
    expect(
      screen.getByText('Axis deleted.', { selector: '.navigation-notice span' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('stays on the page with the reason when the delete is refused', async () => {
    const user = userEvent.setup();
    const deletePermanently = vi.fn(() =>
      Promise.resolve(
        rejected({
          code: 'delete_restricted',
          message: 'Something new is linked. Nothing was deleted.',
        }),
      ),
    );
    renderDanger(
      fakeAlignment({ previewDelete: () => Promise.resolve(deleteImpact()), deletePermanently }),
    );
    await user.click(screen.getByRole('button', { name: 'Delete permanently…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this Axis permanently?' });
    expect(await within(dialog).findByText('Nothing blocks deleting this Axis.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.type(within(dialog).getByLabelText('Type the Axis title to confirm'), 'Health');
    await user.keyboard('{Enter}');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Something new is linked.');
    expect(screen.getByTestId('location')).toHaveTextContent('/axis/current');
  });

  it('describes Routine defaults, sync, and placements as blockers, never review decisions', () => {
    const messages = deleteBlockerMessages(
      deleteImpact({
        allowed: false,
        blockers: ['history_references', 'pending_mutation', 'open_conflict', 'placements'],
        historyReferences: { reviews: 2, routineDefaults: 1 },
      }),
    );
    expect(messages).toEqual([
      'Routine defaults still refer to this Axis (1 routine default). It cannot be deleted permanently yet; you can archive it instead.',
      'This Axis is still linked or placed. Select “Also remove optional links and placements” to remove them with it, or remove them yourself first.',
      'A change to this Axis is still waiting to sync. Try again once it has synced.',
      'This Axis has an unresolved sync conflict. Resolve it first.',
    ]);
    expect(
      deleteBlockerMessages(
        deleteImpact({
          allowed: false,
          blockers: ['history_references'],
          historyReferences: { reviews: 1, routineDefaults: 0 },
        }),
      ),
    ).toEqual([
      'Some history still refers to this Axis. It cannot be deleted permanently yet; you can archive it instead.',
    ]);
    expect(
      deleteBlockerMessages(
        deleteImpact({ historyReferences: { reviews: 4, routineDefaults: 0 } }),
      ),
    ).toEqual([]);
  });

  it('says calmly that review decisions stay in history, and still lets the delete continue', async () => {
    const user = userEvent.setup();
    const previewDelete = vi.fn(() =>
      Promise.resolve(deleteImpact({ historyReferences: { reviews: 3, routineDefaults: 0 } })),
    );
    renderDanger(fakeAlignment({ previewDelete }));
    await user.click(screen.getByRole('button', { name: 'Delete permanently…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this Axis permanently?' });
    expect(await within(dialog).findByText('Nothing blocks deleting this Axis.')).toBeVisible();
    expect(
      within(dialog).getByText('3 review decisions about it stay in history as “Deleted object”.'),
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeVisible();
  });

  it('words one kept review decision in the singular and shows nothing when there are none', async () => {
    expect(
      keptReviewsText(deleteImpact({ historyReferences: { reviews: 1, routineDefaults: 0 } })),
    ).toBe('1 review decision about it stays in history as “Deleted object”.');
    expect(keptReviewsText(deleteImpact())).toBeNull();
    const user = userEvent.setup();
    renderDanger(fakeAlignment({ previewDelete: () => Promise.resolve(deleteImpact()) }));
    await user.click(screen.getByRole('button', { name: 'Delete permanently…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this Axis permanently?' });
    expect(await within(dialog).findByText('Nothing blocks deleting this Axis.')).toBeVisible();
    expect(within(dialog).queryByText(/Deleted object/u)).not.toBeInTheDocument();
  });
});
