// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { installDialogPolyfill } from '../plan/__fixtures__/c1-planning-fake';
import { AccountNoticeBanner } from './account-notice';
import { accountTree, fakeNotices, fakeSync } from './__fixtures__/account-fakes';
import { accountOutcomes } from './sync-text';

/*
 * After an operation switched the open plan, its outcome is shown once where the person is: in the
 * frame, or on the Account page in the page's own result region.
 */

beforeAll(installDialogPolyfill);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A page that, like the app's views, moves focus to its own heading when it appears. */
function FocusingPage(): ReactNode {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Today
      </h1>
      <Link to="/review">Review</Link>
    </>
  );
}

function renderFrame(
  path: string,
  announce?: (notices: ReturnType<typeof fakeNotices>) => void,
  banner: ReactNode = <AccountNoticeBanner />,
) {
  const notices = fakeNotices();
  announce?.(notices);
  render(
    accountTree({
      path,
      notices: notices.notices,
      sync: fakeSync(),
      frame: banner,
      element: <FocusingPage />,
    }),
  );
  return { notices, user: userEvent.setup() };
}

describe('the outcome of an operation that switched the open plan', () => {
  it('is shown once in the frame and takes focus after the new page’s own focus', async () => {
    const { notices, user } = renderFrame('/', (held) => held.announce(accountOutcomes.signedOut));
    const region = screen.getByRole('region', { name: 'Account notice' });
    const text = within(region).getByText(accountOutcomes.signedOut);
    expect(within(region).getByRole('status')).toContainElement(text);
    await waitFor(() => expect(text).toHaveFocus());
    // Shown once: nothing else shows it again.
    expect(notices.notices.current()).toBeNull();
    // Moving on to another page leaves it behind.
    await user.click(screen.getByRole('link', { name: 'Review' }));
    expect(screen.queryByRole('region', { name: 'Account notice' })).toBeNull();
  });

  it('on the Account page, is the page’s own result, without a second copy', async () => {
    const { notices } = renderFrame('/account', (held) =>
      held.announce(accountOutcomes.deletedKeptCopy),
    );
    const message = await screen.findByText(accountOutcomes.deletedKeptCopy, {
      selector: '.account-page > .account-status-region > p',
    });
    await waitFor(() => expect(message).toHaveFocus());
    expect(screen.getAllByText(accountOutcomes.deletedKeptCopy)).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Account notice' })).toBeNull();
    expect(notices.notices.current()).toBeNull();
  });

  it('announces a failure assertively, and Dismiss removes it', async () => {
    const failure =
      'You are signed out. This device’s copy could not be removed yet; YelAxis Planner removes it the next time it opens.';
    const { user } = renderFrame('/', (held) => held.announce(failure, 'alert'));
    const region = screen.getByRole('region', { name: 'Account notice' });
    expect(within(region).getByRole('alert')).toHaveTextContent(failure);
    await user.click(within(region).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'Account notice' })).toBeNull();
  });

  it('shows an outcome that settles after the new page appeared', async () => {
    const { notices } = renderFrame('/');
    expect(screen.queryByRole('region', { name: 'Account notice' })).toBeNull();
    act(() => notices.announce(accountOutcomes.removedDeletedCopy));
    const text = await screen.findByText(accountOutcomes.removedDeletedCopy);
    await waitFor(() => expect(text).toHaveFocus());
  });

  it('above the setup journey, is shown even on the Account path, where no Account page renders', async () => {
    // Deleting the account from the Account page with this device's copy opens a fresh local
    // plan, which starts at setup while the address still reads /account.
    const { notices } = renderFrame(
      '/account',
      (held) => held.announce(accountOutcomes.deletedWithCopy),
      <AccountNoticeBanner accountPageMounted={false} />,
    );
    const region = await screen.findByRole('region', { name: 'Account notice' });
    expect(within(region).getByText(accountOutcomes.deletedWithCopy)).toBeInTheDocument();
    expect(notices.notices.current()).toBeNull();
  });

  it('says nothing when no operation switched the plan', () => {
    renderFrame('/');
    expect(screen.queryByRole('region', { name: 'Account notice' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Today' })).toHaveFocus();
  });
});
