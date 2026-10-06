// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApplicationResult, CommandReceipt, NoChangeReceipt } from '@yelaxis/application';

import {
  alignmentPlanning,
  alignmentTree,
  fakeAlignment,
  noChange,
  receipt,
  stubActions,
  undoId,
} from '../alignment/__fixtures__/alignment-fake';
import { fakeToday } from '../today/__fixtures__/today-fake';
import {
  alreadyLinkedMessage,
  CommandFeedback,
  PlanningProvider,
  useAlignment,
  useAlignmentOptional,
  useCommandRunner,
  useTodayApplication,
  useTodayApplicationOptional,
  type CommandRunOptions,
} from './planning-context';

afterEach(() => cleanup());

function LinkProbe({
  operation,
}: {
  readonly operation: () => Promise<ApplicationResult<CommandReceipt | NoChangeReceipt>>;
}): ReactNode {
  const runner = useCommandRunner();
  const [result, setResult] = useState('');
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void runner.run(operation, 'Linked.').then((done) => setResult(String(done)))
        }
      >
        Link
      </button>
      <p>{`done: ${result}`}</p>
      <CommandFeedback runner={runner} />
    </>
  );
}

describe('alignment services', () => {
  it('are available inside the provider and optional outside it', () => {
    const alignment = fakeAlignment();
    function Probe(): ReactNode {
      return <p>{useAlignment() === alignment ? 'same facade' : 'other facade'}</p>;
    }
    render(
      <PlanningProvider planning={alignmentPlanning()} actions={stubActions} alignment={alignment}>
        <Probe />
      </PlanningProvider>,
    );
    expect(screen.getByText('same facade')).toBeVisible();
    cleanup();
    function OptionalProbe(): ReactNode {
      return <p>{useAlignmentOptional() === null ? 'no alignment' : 'alignment'}</p>;
    }
    render(
      <PlanningProvider planning={alignmentPlanning()} actions={stubActions}>
        <OptionalProbe />
      </PlanningProvider>,
    );
    expect(screen.getByText('no alignment')).toBeVisible();
  });
});

describe('Today services', () => {
  it('are available inside the provider and optional outside it', () => {
    const today = fakeToday();
    function Probe(): ReactNode {
      return <p>{useTodayApplication() === today ? 'same facade' : 'other facade'}</p>;
    }
    render(
      <PlanningProvider planning={alignmentPlanning()} actions={stubActions} today={today}>
        <Probe />
      </PlanningProvider>,
    );
    expect(screen.getByText('same facade')).toBeVisible();
    cleanup();
    function OptionalProbe(): ReactNode {
      return <p>{useTodayApplicationOptional() === null ? 'no today' : 'today'}</p>;
    }
    render(
      <PlanningProvider planning={alignmentPlanning()} actions={stubActions}>
        <OptionalProbe />
      </PlanningProvider>,
    );
    expect(screen.getByText('no today')).toBeVisible();
  });

  it('fail clearly when a page needs them and the provider has none', () => {
    function Probe(): ReactNode {
      useTodayApplication();
      return null;
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(
        <PlanningProvider planning={alignmentPlanning()} actions={stubActions}>
          <Probe />
        </PlanningProvider>,
      ),
    ).toThrow('Today services are unavailable.');
    error.mockRestore();
  });
});

function RunProbe({
  label,
  operation,
  options,
}: {
  readonly label: string;
  readonly operation: () => Promise<ApplicationResult<CommandReceipt>>;
  readonly options?: CommandRunOptions;
}): ReactNode {
  const runner = useCommandRunner();
  return (
    <>
      <button type="button" onClick={() => void runner.run(operation, `${label} done.`, options)}>
        {label}
      </button>
      <CommandFeedback runner={runner} />
    </>
  );
}

describe('CommandRunner undo', () => {
  const undone = () => Promise.resolve(receipt(undefined, { undo: false }));
  const tree = (
    planningUndo: () => Promise<ApplicationResult<CommandReceipt>>,
    probe: ReactNode,
  ) => (
    <PlanningProvider planning={alignmentPlanning({ undo: planningUndo })} actions={stubActions}>
      {probe}
    </PlanningProvider>
  );

  it('applies a command’s undo with planning.undo by default', async () => {
    const user = userEvent.setup();
    const planningUndo = vi.fn(undone);
    render(
      tree(planningUndo, <RunProbe label="Place" operation={() => Promise.resolve(receipt())} />),
    );
    await user.click(screen.getByRole('button', { name: 'Place' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Change undone.')).toBeInTheDocument();
    expect(planningUndo).toHaveBeenCalledWith(undoId);
  });

  it('applies the per-run undo when a command gives one, never planning.undo', async () => {
    const user = userEvent.setup();
    const planningUndo = vi.fn(undone);
    const actionsUndo = vi.fn(undone);
    render(
      tree(
        planningUndo,
        <RunProbe
          label="Complete"
          operation={() => Promise.resolve(receipt())}
          options={{ undo: actionsUndo }}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Complete' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Change undone.')).toBeInTheDocument();
    expect(actionsUndo).toHaveBeenCalledExactlyOnceWith(undoId);
    expect(planningUndo).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('keeps a per-run undo with its own command only', async () => {
    const user = userEvent.setup();
    const planningUndo = vi.fn(undone);
    const actionsUndo = vi.fn(undone);
    function TwoCommands(): ReactNode {
      const runner = useCommandRunner();
      return (
        <>
          <button
            type="button"
            onClick={() =>
              void runner.run(() => Promise.resolve(receipt()), 'Completed.', {
                undo: actionsUndo,
              })
            }
          >
            Complete
          </button>
          <button
            type="button"
            onClick={() => void runner.run(() => Promise.resolve(receipt()), 'Moved.')}
          >
            Move
          </button>
          <CommandFeedback runner={runner} />
        </>
      );
    }
    render(tree(planningUndo, <TwoCommands />));
    await user.click(screen.getByRole('button', { name: 'Complete' }));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('Moved.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Change undone.')).toBeInTheDocument();
    expect(planningUndo).toHaveBeenCalledExactlyOnceWith(undoId);
    expect(actionsUndo).not.toHaveBeenCalled();
  });

  it('drops the per-run undo when the next command offers none', async () => {
    const user = userEvent.setup();
    const actionsUndo = vi.fn(undone);
    let next: ApplicationResult<CommandReceipt> = receipt();
    render(
      tree(
        vi.fn(undone),
        <RunProbe
          label="Complete"
          operation={() => Promise.resolve(next)}
          options={{ undo: actionsUndo }}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Complete' }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();
    next = receipt(undefined, { undo: false });
    await user.click(screen.getByRole('button', { name: 'Complete' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument(),
    );
    expect(actionsUndo).not.toHaveBeenCalled();
  });
});

describe('CommandRunner', () => {
  it('announces an existing link without writing or offering undo', async () => {
    const user = userEvent.setup();
    render(
      alignmentTree(fakeAlignment(), <LinkProbe operation={() => Promise.resolve(noChange())} />),
    );
    await user.click(screen.getByRole('button', { name: 'Link' }));
    expect(await screen.findByText('done: true')).toBeVisible();
    expect(alreadyLinkedMessage).toBe('Already linked. Nothing changed.');
    // Once in the polite region and once as visible text.
    expect(screen.getAllByText(alreadyLinkedMessage)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('offers undo after a committed change and clears the notice', async () => {
    const user = userEvent.setup();
    let next: ApplicationResult<CommandReceipt | NoChangeReceipt> = noChange();
    render(alignmentTree(fakeAlignment(), <LinkProbe operation={() => Promise.resolve(next)} />));
    await user.click(screen.getByRole('button', { name: 'Link' }));
    expect(await screen.findByText('done: true')).toBeVisible();
    next = receipt();
    await user.click(screen.getByRole('button', { name: 'Link' }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();
    expect(screen.queryByText(alreadyLinkedMessage)).not.toBeInTheDocument();
    expect(screen.getByText('Linked.')).toBeInTheDocument();
  });
});
