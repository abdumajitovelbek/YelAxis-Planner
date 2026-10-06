// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AlignmentApplication, OutcomeItem } from '@yelaxis/application';

import { CommandFeedback, useCommandRunner } from '../plan/planning-context';
import {
  alignmentNode,
  alignmentTree,
  axisSummary,
  fakeAlignment,
  ids,
  installDialogPolyfill,
  outcomeItem,
  projectItem,
  receipt,
  rejected,
  revisionConflict,
} from './__fixtures__/alignment-fake';
import {
  AxisFormDialog,
  MilestoneFormDialog,
  OutcomeFormDialog,
  ProgressEditor,
  ProjectFormDialog,
} from './object-forms';

beforeAll(installDialogPolyfill);
afterEach(() => cleanup());

type Opener = (props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly runner: ReturnType<typeof useCommandRunner>;
}) => ReactNode;

/** A page with an opener button, the dialog, and the runner's feedback. */
function Harness({
  dialog,
  label = 'Open form',
}: {
  readonly dialog: Opener;
  readonly label?: string;
}): ReactNode {
  const runner = useCommandRunner();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {label}
      </button>
      {dialog({ open, onClose: () => setOpen(false), runner })}
      <CommandFeedback runner={runner} />
    </>
  );
}

function renderForm(alignment: AlignmentApplication, dialog: Opener) {
  return render(alignmentTree(alignment, <Harness dialog={dialog} />));
}

const dialogNamed = (name: string): HTMLElement => screen.getByRole('dialog', { name });

describe('AxisFormDialog', () => {
  it('validates in words, keeps entered values, and focuses the problem', async () => {
    const user = userEvent.setup();
    const createAxis = vi.fn();
    renderForm(fakeAlignment({ createAxis }), (props) => (
      <AxisFormDialog mode="create" {...props} />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('New Axis');
    await user.type(within(dialog).getByLabelText('Purpose'), 'Feel rested');
    await user.click(within(dialog).getByRole('button', { name: 'Create Axis' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Add a title.');
    const title = within(dialog).getByLabelText('Title');
    expect(title).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(title).toHaveFocus());
    expect(within(dialog).getByLabelText('Purpose')).toHaveValue('Feel rested');
    expect(createAxis).not.toHaveBeenCalled();
  });

  it('creates a trimmed Axis with a named color and reports the new id', async () => {
    const user = userEvent.setup();
    const createAxis = vi.fn(() => Promise.resolve(receipt({ type: 'axis', id: ids.craft })));
    const onSaved = vi.fn();
    renderForm(fakeAlignment({ createAxis }), (props) => (
      <AxisFormDialog mode="create" onSaved={onSaved} {...props} />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('New Axis');
    expect(
      within(within(dialog).getByLabelText('Color'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['No color', 'Cyan', 'Violet', 'Emerald', 'Amber', 'Rose', 'Slate']);
    await user.type(within(dialog).getByLabelText('Title'), '  Craft  ');
    await user.selectOptions(within(dialog).getByLabelText('Color'), 'Violet');
    await user.click(within(dialog).getByRole('button', { name: 'Create Axis' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(ids.craft, expect.anything()));
    expect(createAxis).toHaveBeenCalledWith({ title: 'Craft', color: 'violet' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open form' })).toHaveFocus();
  });

  it('edits with the expected revision and keeps an existing icon', async () => {
    const user = userEvent.setup();
    const editAxis = vi.fn(() => Promise.resolve(receipt()));
    const axis = axisSummary({ icon: 'leaf' });
    renderForm(fakeAlignment({ editAxis }), (props) => (
      <AxisFormDialog mode="edit" initial={axis} {...props} />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('Edit Axis');
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Health');
    const icon = within(dialog).getByRole('group', { name: 'Icon' });
    expect(within(icon).getByRole('radio', { name: 'Keep the current icon' })).toBeChecked();
    const purpose = within(dialog).getByLabelText('Purpose');
    await user.clear(purpose);
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(editAxis).toHaveBeenCalledWith(
        { kind: 'axis', id: ids.health, revision: 3 },
        { title: 'Health', color: 'emerald', icon: 'leaf' },
      ),
    );
  });

  it('offers No icon and the catalog icons, and creates an Axis with the chosen icon', async () => {
    const user = userEvent.setup();
    const createAxis = vi.fn(() => Promise.resolve(receipt({ type: 'axis', id: ids.craft })));
    renderForm(fakeAlignment({ createAxis }), (props) => (
      <AxisFormDialog mode="create" {...props} />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('New Axis');
    const icon = within(dialog).getByRole('group', { name: 'Icon' });
    expect(
      within(icon)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('value')),
    ).toEqual(['', 'standard']);
    expect(within(icon).getByRole('radio', { name: 'No icon' })).toBeChecked();
    await user.type(within(dialog).getByLabelText('Title'), 'Craft');
    await user.click(within(icon).getByRole('radio', { name: 'Standard' }));
    expect(icon.querySelector('img[data-axis-icon="standard"]')).toHaveAttribute('alt', '');
    await user.click(within(dialog).getByRole('button', { name: 'Create Axis' }));
    await waitFor(() =>
      expect(createAxis).toHaveBeenCalledWith({ title: 'Craft', icon: 'standard' }),
    );
  });

  it('clears the icon when No icon is chosen while editing', async () => {
    const user = userEvent.setup();
    const editAxis = vi.fn(() => Promise.resolve(receipt()));
    renderForm(fakeAlignment({ editAxis }), (props) => (
      <AxisFormDialog mode="edit" initial={axisSummary({ icon: 'standard' })} {...props} />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const icon = within(dialogNamed('Edit Axis')).getByRole('group', { name: 'Icon' });
    expect(within(icon).getByRole('radio', { name: 'Standard' })).toBeChecked();
    await user.click(within(icon).getByRole('radio', { name: 'No icon' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(editAxis).toHaveBeenCalledWith(
        { kind: 'axis', id: ids.health, revision: 3 },
        { title: 'Health', purpose: 'Feel strong and rested through the year.', color: 'emerald' },
      ),
    );
  });

  it('shows a command failure next to the field it names', async () => {
    const user = userEvent.setup();
    const createAxis = vi.fn(() =>
      Promise.resolve(
        rejected({
          code: 'invalid_value',
          message: 'Keep the title to 80 characters or fewer.',
          details: { reason: 'title_too_long', field: 'title' },
        }),
      ),
    );
    renderForm(fakeAlignment({ createAxis }), (props) => (
      <AxisFormDialog mode="create" {...props} />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('New Axis');
    await user.type(within(dialog).getByLabelText('Title'), 'Craft');
    await user.click(within(dialog).getByRole('button', { name: 'Create Axis' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Keep the title to 80 characters or fewer.',
    );
    expect(within(dialog).getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true');
    // The page's own feedback does not repeat the error while the dialog shows it.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('shows a revision conflict calmly and keeps the draft', async () => {
    const user = userEvent.setup();
    const editAxis = vi.fn(() => Promise.resolve(revisionConflict('axis', ids.health)));
    renderForm(fakeAlignment({ editAxis }), (props) => (
      <AxisFormDialog mode="edit" initial={axisSummary()} {...props} />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('Edit Axis');
    await user.type(within(dialog).getByLabelText('Title'), ' and rest');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This item changed.');
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Health and rest');
  });

  it('asks before discarding changes and keeps them on Continue editing', async () => {
    const user = userEvent.setup();
    const createAxis = vi.fn(() => Promise.resolve(receipt({ type: 'axis', id: ids.craft })));
    renderForm(fakeAlignment({ createAxis }), (props) => (
      <AxisFormDialog mode="create" {...props} />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    await user.type(within(dialogNamed('New Axis')).getByLabelText('Title'), 'Craft');
    await user.keyboard('{Escape}');
    // jsdom does not fire the dialog cancel event for Escape; Cancel follows the same guard.
    await user.click(within(dialogNamed('New Axis')).getByRole('button', { name: 'Cancel' }));
    const guard = dialogNamed('Save your changes before leaving?');
    expect(within(guard).getByRole('button', { name: 'Save' })).toBeVisible();
    expect(within(guard).getByRole('button', { name: 'Discard' })).toBeVisible();
    await user.click(within(guard).getByRole('button', { name: 'Continue editing' }));
    expect(within(dialogNamed('New Axis')).getByLabelText('Title')).toHaveValue('Craft');
    await user.click(within(dialogNamed('New Axis')).getByRole('button', { name: 'Close' }));
    await user.click(
      within(dialogNamed('Save your changes before leaving?')).getByRole('button', {
        name: 'Discard',
      }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(createAxis).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open form' })).toHaveFocus();
  });

  it('closes an unchanged form at once and returns focus to the opener', async () => {
    const user = userEvent.setup();
    renderForm(fakeAlignment(), (props) => <AxisFormDialog mode="create" {...props} />);
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    await user.click(within(dialogNamed('New Axis')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open form' })).toHaveFocus();
  });
});

describe('OutcomeFormDialog', () => {
  it('starts in the preset Axis and checks the target window', async () => {
    const user = userEvent.setup();
    const createOutcome = vi.fn(() =>
      Promise.resolve(receipt({ type: 'outcome', id: ids.halfMarathon })),
    );
    const listChoices = vi.fn(() =>
      Promise.resolve([
        alignmentNode('axis', ids.health, 'Health'),
        alignmentNode('axis', ids.craft, 'Craft'),
      ]),
    );
    renderForm(fakeAlignment({ createOutcome, listChoices }), (props) => (
      <OutcomeFormDialog mode="create" preset={{ axisId: ids.craft }} {...props} />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('New Outcome');
    await waitFor(() => expect(within(dialog).getByLabelText('Axis')).toHaveDisplayValue('Craft'));
    expect(listChoices).toHaveBeenCalledWith('axis');
    await user.type(within(dialog).getByLabelText('Title'), 'Publish a short story');
    await user.type(within(dialog).getByLabelText('Success definition'), 'Accepted by a magazine');
    fireEvent.change(within(dialog).getByLabelText('Target start'), {
      target: { value: '2026-12-01' },
    });
    fireEvent.change(within(dialog).getByLabelText('Target end'), {
      target: { value: '2026-11-01' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Create Outcome' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'The target end must be on or after the target start.',
    );
    expect(within(dialog).getByLabelText('Target end')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(within(dialog).getByLabelText('Target end'), {
      target: { value: '2027-01-31' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Create Outcome' }));
    await waitFor(() =>
      expect(createOutcome).toHaveBeenCalledWith({
        title: 'Publish a short story',
        successDefinition: 'Accepted by a magazine',
        targetStart: '2026-12-01',
        targetEnd: '2027-01-31',
        axisId: ids.craft,
      }),
    );
  });

  it('requires a success definition', async () => {
    const user = userEvent.setup();
    renderForm(fakeAlignment({ listChoices: vi.fn(() => Promise.resolve([])) }), (props) => (
      <OutcomeFormDialog mode="create" {...props} />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('New Outcome');
    await user.type(within(dialog).getByLabelText('Title'), 'Rest');
    await user.click(within(dialog).getByRole('button', { name: 'Create Outcome' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Add a success definition.');
  });

  it('edits without offering the Axis (links change membership)', async () => {
    const user = userEvent.setup();
    const editOutcome = vi.fn(() => Promise.resolve(receipt()));
    renderForm(fakeAlignment({ editOutcome }), (props) => (
      <OutcomeFormDialog mode="edit" initial={outcomeItem()} {...props} />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('Edit Outcome');
    expect(within(dialog).queryByLabelText('Axis')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(editOutcome).toHaveBeenCalledWith(
        { kind: 'outcome', id: ids.halfMarathon, revision: 2 },
        {
          title: 'Run a half marathon',
          successDefinition: 'Finish a spring half marathon without injury.',
          targetStart: '2026-10-01',
          targetEnd: '2027-04-30',
        },
      ),
    );
  });
});

describe('ProjectFormDialog', () => {
  it('needs a desired result to start active', async () => {
    const user = userEvent.setup();
    const createProject = vi.fn(() =>
      Promise.resolve(receipt({ type: 'project', id: ids.trainingPlan })),
    );
    renderForm(
      fakeAlignment({ createProject, listChoices: vi.fn(() => Promise.resolve([])) }),
      (props) => <ProjectFormDialog mode="create" preset={{ axisId: ids.health }} {...props} />,
    );
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('New Project');
    await user.type(within(dialog).getByLabelText('Title'), 'Training plan');
    await user.click(within(dialog).getByRole('radio', { name: 'Active' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create Project' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Add a desired result before activating this Project.',
    );
    await user.type(within(dialog).getByLabelText('Desired result'), 'A sixteen-week plan');
    await user.type(within(dialog).getByLabelText('Notes'), 'Ask the club');
    await user.click(within(dialog).getByRole('button', { name: 'Create Project' }));
    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({
        title: 'Training plan',
        desiredResult: 'A sixteen-week plan',
        notes: 'Ask the club',
        axisId: ids.health,
        state: 'active',
      }),
    );
  });

  it('starts as an idea without a desired result', async () => {
    const user = userEvent.setup();
    const createProject = vi.fn(() =>
      Promise.resolve(receipt({ type: 'project', id: ids.websiteIdea })),
    );
    renderForm(
      fakeAlignment({ createProject, listChoices: vi.fn(() => Promise.resolve([])) }),
      (props) => <ProjectFormDialog mode="create" {...props} />,
    );
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('New Project');
    expect(within(dialog).getByRole('radio', { name: 'Idea' })).toBeChecked();
    await user.type(within(dialog).getByLabelText('Title'), 'Portfolio website');
    await user.click(within(dialog).getByRole('button', { name: 'Create Project' }));
    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({ title: 'Portfolio website', state: 'idea' }),
    );
  });

  it('keeps the desired result of an active Project when editing', async () => {
    const user = userEvent.setup();
    const editProject = vi.fn();
    renderForm(fakeAlignment({ editProject }), (props) => (
      <ProjectFormDialog mode="edit" initial={projectItem()} {...props} />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('Edit Project');
    await user.clear(within(dialog).getByLabelText('Desired result'));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Keep a desired result.');
    expect(editProject).not.toHaveBeenCalled();
  });
});

describe('MilestoneFormDialog', () => {
  it('creates under the preset Outcome', async () => {
    const user = userEvent.setup();
    const createMilestone = vi.fn(() =>
      Promise.resolve(receipt({ type: 'milestone', id: ids.baseMiles })),
    );
    renderForm(fakeAlignment({ createMilestone }), (props) => (
      <MilestoneFormDialog
        mode="create"
        preset={{ outcomeId: ids.halfMarathon, outcomeTitle: 'Run a half marathon' }}
        {...props}
      />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('New Milestone');
    expect(within(dialog).getByText('For the Outcome “Run a half marathon”.')).toBeVisible();
    expect(within(dialog).queryByLabelText('Outcome')).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Title'), 'Base miles');
    await user.type(within(dialog).getByLabelText('Measurable checkpoint'), '30 km a week');
    await user.click(within(dialog).getByRole('button', { name: 'Create Milestone' }));
    await waitFor(() =>
      expect(createMilestone).toHaveBeenCalledWith({
        outcomeId: ids.halfMarathon,
        title: 'Base miles',
        measurableCheckpoint: '30 km a week',
      }),
    );
  });

  it('asks for an Outcome when none is preset', async () => {
    const user = userEvent.setup();
    const listChoices = vi.fn(() =>
      Promise.resolve([alignmentNode('outcome', ids.halfMarathon, 'Run a half marathon')]),
    );
    renderForm(fakeAlignment({ listChoices }), (props) => (
      <MilestoneFormDialog mode="create" {...props} />
    ));
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    const dialog = dialogNamed('New Milestone');
    await user.type(within(dialog).getByLabelText('Title'), 'Race day');
    await user.type(within(dialog).getByLabelText('Measurable checkpoint'), 'Cross the line');
    await user.click(within(dialog).getByRole('button', { name: 'Create Milestone' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Choose the Outcome this Milestone belongs to.',
    );
    expect(listChoices).toHaveBeenCalledWith('outcome');
  });
});

describe('ProgressEditor', () => {
  function ProgressHarness({ outcome }: { readonly outcome: OutcomeItem }): ReactNode {
    const runner = useCommandRunner();
    return (
      <>
        <ProgressEditor outcome={outcome} runner={runner} />
        <CommandFeedback runner={runner} />
      </>
    );
  }

  it('offers three ways to show progress and validates a manual percentage', async () => {
    const user = userEvent.setup();
    const setOutcomeProgress = vi.fn(() => Promise.resolve(receipt()));
    render(
      alignmentTree(
        fakeAlignment({ setOutcomeProgress }),
        <ProgressHarness
          outcome={outcomeItem({ progress: { mode: 'none' }, canceledMilestones: 0 })}
        />,
      ),
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Progress' })).toBeVisible();
    expect(screen.getByText('No progress measure')).toBeVisible();
    const group = screen.getByRole('group', { name: 'Show progress as' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['No percentage', 'Set manually', 'From milestones']);
    await user.click(screen.getByRole('radio', { name: 'Set manually' }));
    const percentage = screen.getByLabelText('Percentage');
    await user.type(percentage, '140');
    await user.click(screen.getByRole('button', { name: 'Save progress' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number from 0 to 100.');
    expect(percentage).toHaveAttribute('aria-invalid', 'true');
    expect(setOutcomeProgress).not.toHaveBeenCalled();
    await user.clear(percentage);
    await user.type(percentage, '40');
    await user.click(screen.getByRole('button', { name: 'Save progress' }));
    await waitFor(() =>
      expect(setOutcomeProgress).toHaveBeenCalledWith(
        { kind: 'outcome', id: ids.halfMarathon, revision: 2 },
        { mode: 'manual', percentage: 40 },
      ),
    );
  });

  it('switches to milestone counts and explains them', async () => {
    const user = userEvent.setup();
    const setOutcomeProgress = vi.fn(() => Promise.resolve(receipt()));
    render(
      alignmentTree(
        fakeAlignment({ setOutcomeProgress }),
        <ProgressHarness outcome={outcomeItem({ progress: { mode: 'manual', percentage: 40 } })} />,
      ),
    );
    expect(screen.getByText('40% (set manually)')).toBeVisible();
    await user.click(screen.getByRole('radio', { name: 'From milestones' }));
    expect(screen.getByText(/Canceled Milestones are listed separately/u)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save progress' }));
    await waitFor(() =>
      expect(setOutcomeProgress).toHaveBeenCalledWith(
        { kind: 'outcome', id: ids.halfMarathon, revision: 2 },
        { mode: 'milestone_derived' },
      ),
    );
  });

  it('is read-only for an archived Outcome', () => {
    render(
      alignmentTree(
        fakeAlignment(),
        <ProgressHarness outcome={outcomeItem({ state: 'archived' })} />,
      ),
    );
    expect(screen.getByText('1 of 2 milestones completed · 1 canceled')).toBeVisible();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save progress' })).not.toBeInTheDocument();
  });
});
