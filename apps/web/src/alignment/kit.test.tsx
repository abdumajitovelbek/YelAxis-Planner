// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { Route, useNavigate } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OutcomeDetail } from '@yelaxis/application';

import {
  alignmentPlanning,
  alignmentTree,
  fakeAlignment,
  history,
  ids,
  installDialogPolyfill,
  outcomeDetail,
  receipt,
  undoId,
} from './__fixtures__/alignment-fake';
import {
  HistoryList,
  MoveButtons,
  noticeState,
  ObjectPage,
  StatusPill,
  useObjectQuery,
} from './kit';

beforeAll(installDialogPolyfill);
afterEach(() => cleanup());

function OutcomeTitle({
  id,
  load,
}: {
  readonly id: string;
  readonly load: () => Promise<OutcomeDetail | null>;
}): ReactNode {
  return (
    <ObjectPage kind="outcome" id={id} load={load}>
      {(detail) => <h1>{detail.outcome.title}</h1>}
    </ObjectPage>
  );
}

describe('ObjectPage deep links', () => {
  it('shows a busy loading heading, then the object', async () => {
    let resolve: (value: OutcomeDetail) => void = () => undefined;
    const load = vi.fn(
      () =>
        new Promise<OutcomeDetail>((done) => {
          resolve = done;
        }),
    );
    render(alignmentTree(fakeAlignment(), <OutcomeTitle id={ids.halfMarathon} load={load} />));
    const loading = screen.getByRole('heading', { level: 1, name: 'Opening Outcome…' });
    expect(loading.closest('section')).toHaveAttribute('aria-busy', 'true');
    resolve(outcomeDetail());
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Run a half marathon' }),
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(load).toHaveBeenCalledWith(ids.halfMarathon);
  });

  it('never queries a malformed id and says it is unavailable', async () => {
    const load = vi.fn();
    render(alignmentTree(fakeAlignment(), <OutcomeTitle id="not-an-id" load={load} />));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This Outcome is unavailable' }),
    ).toBeVisible();
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back to Axes' })).toHaveAttribute('href', '/axis');
  });

  it('says a missing object is unavailable', async () => {
    render(
      alignmentTree(
        fakeAlignment(),
        <OutcomeTitle id={ids.halfMarathon} load={() => Promise.resolve(null)} />,
      ),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This Outcome is unavailable' }),
    ).toBeVisible();
    expect(screen.getByText(/Your plan was not changed/u)).toBeVisible();
  });

  it('recovers from a read error with Try again', async () => {
    const user = userEvent.setup();
    const load = vi
      .fn<() => Promise<OutcomeDetail | null>>()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(outcomeDetail());
    render(alignmentTree(fakeAlignment(), <OutcomeTitle id={ids.halfMarathon} load={load} />));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
    expect(
      screen.getByRole('heading', { level: 1, name: 'This Outcome could not be opened' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to Axes' })).toHaveAttribute('href', '/axis');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Run a half marathon' }),
    ).toBeVisible();
  });

  it('re-queries in place when a page option changes', async () => {
    const user = userEvent.setup();
    const load = vi.fn((id: string, finished: boolean) =>
      Promise.resolve({ id, finished: String(finished) }),
    );
    function Probe(): ReactNode {
      const [finished, setFinished] = useState(false);
      const { state } = useObjectQuery(ids.health, (id) => load(id, finished), [finished]);
      return (
        <>
          <button type="button" onClick={() => setFinished(true)}>
            Include finished
          </button>
          <p>
            {state.status === 'ready' ? `finished: ${state.data?.finished ?? ''}` : state.status}
          </p>
        </>
      );
    }
    render(alignmentTree(fakeAlignment(), <Probe />));
    expect(await screen.findByText('finished: false')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Include finished' }));
    expect(await screen.findByText('finished: true')).toBeVisible();
    expect(screen.queryByText('loading')).not.toBeInTheDocument();
  });
});

describe('StatusPill, MoveButtons, and HistoryList', () => {
  it('shows state as text', () => {
    render(<StatusPill label="Paused" />);
    expect(screen.getByText('Paused')).toHaveClass('status-pill');
  });

  it('names both moves for the item and keeps the ends focusable but inactive', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(<MoveButtons itemLabel="Health" isFirst isLast={false} onMove={onMove} />);
    expect(screen.getByRole('group', { name: 'Order of Health' })).toBeVisible();
    const up = screen.getByRole('button', { name: 'Move Health up' });
    const down = screen.getByRole('button', { name: 'Move Health down' });
    expect(up).toHaveAttribute('aria-disabled', 'true');
    expect(down).toHaveAttribute('aria-disabled', 'false');
    await user.click(up);
    expect(onMove).not.toHaveBeenCalled();
    down.focus();
    await user.keyboard('{Enter}');
    expect(onMove).toHaveBeenCalledWith('down');
  });

  it('ignores moves while a command is saving', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(
      <MoveButtons itemLabel="Craft" isFirst={false} isLast={false} disabled onMove={onMove} />,
    );
    await user.click(screen.getByRole('button', { name: 'Move Craft up' }));
    expect(onMove).not.toHaveBeenCalled();
  });

  it('lists history in words with machine-readable times', () => {
    render(<HistoryList entries={history} />);
    expect(screen.getByRole('heading', { level: 2, name: 'History' })).toBeVisible();
    expect(screen.getByText('Details edited')).toBeVisible();
    expect(screen.getByText('Saved during setup')).toBeVisible();
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-09-27T10:15:00.000Z');
  });

  it('says when there is no history yet', () => {
    render(<HistoryList entries={[]} />);
    expect(screen.getByText('No history yet.')).toBeVisible();
  });
});

describe('NavigationNotice', () => {
  function Leave(): ReactNode {
    const navigate = useNavigate();
    return (
      <button
        type="button"
        onClick={() => void navigate('/next', { state: noticeState('Axis created.', undoId) })}
      >
        Create
      </button>
    );
  }

  it('shows the confirmation on the next page with a working Undo', async () => {
    const user = userEvent.setup();
    const undo = vi.fn(() => Promise.resolve(receipt()));
    const planning = alignmentPlanning({ undo });
    render(alignmentTree(fakeAlignment(), <Leave />, { notice: true, planning }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(
      await screen.findByText('Axis created.', { selector: '.navigation-notice span' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith(undoId));
    expect(
      await screen.findByText('Change undone.', { selector: '.navigation-notice span' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('disappears once the person moves on', async () => {
    const user = userEvent.setup();
    function Next(): ReactNode {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => void navigate('/later')}>
          Somewhere else
        </button>
      );
    }
    render(
      alignmentTree(fakeAlignment(), <Leave />, {
        notice: true,
        extraRoutes: <Route path="/next" element={<Next />} />,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(
      await screen.findByText('Axis created.', { selector: '.navigation-notice span' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Somewhere else' }));
    expect(await screen.findByText('Another page')).toBeVisible();
    expect(document.querySelector('.navigation-notice')).toBeNull();
  });
});
