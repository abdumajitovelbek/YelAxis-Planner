// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PlanningApplication } from '@yelaxis/application';

import { installDialogPolyfill } from '../plan/__fixtures__/c1-planning-fake';
import { PlanningProvider, useCommandRunner } from '../plan/planning-context';
import {
  actionsFake,
  ids,
  node,
  planningFake,
  receipt,
  uuid,
} from './__fixtures__/detail-fixtures';
import {
  alignmentNode,
  DetailList,
  edgeTo,
  lifecycleTarget,
  nodePath,
  PlacementDialog,
} from './detail-parts';

beforeAll(() => installDialogPolyfill());

afterEach(() => cleanup());

describe('detail helpers', () => {
  it('links every node kind to its page except Notes', () => {
    expect(nodePath('axis', ids.axis)).toBe(`/axis/${ids.axis}`);
    expect(nodePath('outcome', ids.outcome)).toBe(`/outcomes/${ids.outcome}`);
    expect(nodePath('project', ids.project)).toBe(`/projects/${ids.project}`);
    expect(nodePath('milestone', ids.milestone)).toBe(`/milestones/${ids.milestone}`);
    expect(nodePath('action', ids.action)).toBe(`/actions/${ids.action}`);
    expect(nodePath('routine', uuid(99))).toBe(`/plan/routines/${uuid(99)}`);
    expect(nodePath('note', ids.note)).toBeNull();
  });

  it('builds nodes, lifecycle targets, and edges from the relationship catalog', () => {
    const outcome = alignmentNode('outcome', { ...node(ids.outcome, 'Launch'), localRevision: 2 });
    expect(outcome).toEqual({
      kind: 'outcome',
      id: ids.outcome,
      title: 'Launch',
      state: 'active',
      archived: false,
      localRevision: 2,
    });
    expect(
      alignmentNode('outcome', {
        id: ids.outcome,
        title: 'Launch',
        state: 'archived',
        localRevision: 3,
      }).archived,
    ).toBe(true);
    expect(lifecycleTarget('outcome', { ...outcome })).toEqual({
      kind: 'outcome',
      id: ids.outcome,
      revision: 2,
      title: 'Launch',
    });
    expect(edgeTo('outcome_milestone', 'up', outcome)).toEqual({
      relationship: 'outcome_milestone',
      direction: 'up',
      required: true,
      other: outcome,
    });
    expect(
      edgeTo('milestone_project', 'down', outcome, { linkId: ids.link, linkRevision: 4 }),
    ).toEqual({
      relationship: 'milestone_project',
      direction: 'down',
      required: false,
      other: outcome,
      linkId: ids.link,
      linkRevision: 4,
    });
  });

  it('lists related objects with their state in words and an empty text', () => {
    render(
      <MemoryRouter>
        <DetailList
          ordered
          label="Actions of Research notes"
          empty="No actions yet."
          rows={[
            {
              key: 'one',
              kind: 'action',
              node: node(ids.action, 'Outline scene list', 'in_progress'),
              facts: ['Target by Aug 1, 2026'],
            },
            {
              key: 'two',
              kind: 'action',
              node: node(ids.actionTwo, 'Old idea', 'archived', true),
            },
          ]}
        />
        <DetailList label="Captured notes" empty="No captured notes." rows={[]} />
      </MemoryRouter>,
    );
    const rows = within(
      screen.getByRole('list', { name: 'Actions of Research notes' }),
    ).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('In progress');
    expect(rows[0]).toHaveTextContent('Target by Aug 1, 2026');
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: 'Outline scene list' }),
    ).toHaveAttribute('href', `/actions/${ids.action}`);
    // An archived row says so once, in its state.
    expect(within(rows[1] as HTMLElement).getAllByText('Archived')).toHaveLength(1);
    expect(screen.getByText('No captured notes.')).toBeVisible();
  });
});

function PlacementHarness({
  allowed,
}: {
  readonly allowed: readonly ('year' | 'month' | 'week')[];
}): ReactNode {
  const runner = useCommandRunner();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open placement
      </button>
      <PlacementDialog
        open={open}
        allowed={allowed}
        target={{ kind: 'project', id: ids.project, revision: 5 }}
        title="Research notes"
        runner={runner}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function renderPlacement(
  allowed: readonly ('year' | 'month' | 'week')[],
  planning: PlanningApplication,
): void {
  render(
    <PlanningProvider planning={planning} actions={actionsFake()}>
      <MemoryRouter>
        <PlacementHarness allowed={allowed} />
      </MemoryRouter>
    </PlanningProvider>,
  );
}

describe('Placement dialog', () => {
  it('offers only the allowed horizons and validates the week date', async () => {
    const user = userEvent.setup();
    const place = vi.fn().mockResolvedValue(receipt());
    renderPlacement(['month', 'week'], planningFake({ place }));
    await user.click(screen.getByRole('button', { name: 'Open placement' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place “Research notes”' });
    expect(within(dialog).getAllByRole('radio')).toHaveLength(2);
    expect(within(dialog).getByRole('radio', { name: 'A month' })).toBeChecked();

    await user.click(within(dialog).getByRole('radio', { name: 'A week' }));
    fireEvent.change(within(dialog).getByLabelText('Any date in the week'), {
      target: { value: '2026-02-30' },
    });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Choose a valid date.');
    await user.click(within(dialog).getByRole('button', { name: 'Place' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Choose a valid date.');
    expect(place).not.toHaveBeenCalled();
  });

  it('shows a single horizon without a choice and keeps the dialog open on a rejection', async () => {
    const user = userEvent.setup();
    const place = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: {
          code: 'placement_not_allowed',
          message: 'This entity cannot be placed at the selected Horizon.',
        },
      },
    });
    renderPlacement(['month'], planningFake({ place }));
    await user.click(screen.getByRole('button', { name: 'Open placement' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place “Research notes”' });
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Place' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This entity cannot be placed at the selected Horizon.',
    );
    expect(screen.getByRole('dialog', { name: 'Place “Research notes”' })).toBeVisible();
  });
});
