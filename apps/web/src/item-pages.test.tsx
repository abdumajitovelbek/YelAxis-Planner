// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { PagedItems } from './item-pages';

afterEach(() => cleanup());

const rows = Array.from({ length: 103 }, (_, index) => ({
  id: index,
  title: `Synthetic ${index + 1}`,
}));
const tree = (items = rows, identity = '2026-10-04') => (
  <ul aria-label="Synthetic rows">
    <PagedItems items={items} identity={identity}>
      {(item, absoluteIndex) => (
        <li key={item.id}>
          {item.title}
          <span>{absoluteIndex}</span>
        </li>
      )}
    </PagedItems>
  </ul>
);

describe('bounded presentation preserves every source row', () => {
  it('exposes all rows in their original order with stable keyboard controls and absolute indices', async () => {
    const user = userEvent.setup();
    render(tree());
    const list = screen.getByRole('list', { name: 'Synthetic rows' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(51);
    expect(screen.getByRole('status')).toHaveTextContent('Items 1–50 of 103');
    const next = screen.getByRole('button', { name: 'Next items' });
    await user.click(next);
    expect(next).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Items 51–100 of 103');
    expect(screen.getByText('Synthetic 51')).toHaveTextContent('Synthetic 5150');
    await user.click(next);
    expect(screen.getByRole('status')).toHaveTextContent('Items 101–103 of 103');
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute('aria-disabled', 'true');
    await user.click(next);
    expect(screen.getByRole('status')).toHaveTextContent('Items 101–103 of 103');
    await user.click(screen.getByRole('button', { name: 'Previous items' }));
    expect(screen.getByRole('status')).toHaveTextContent('Items 51–100 of 103');
  });

  it('resets a changed date and clamps a shrinking result without mutating the source', async () => {
    const user = userEvent.setup();
    const { rerender } = render(tree());
    await user.click(screen.getByRole('button', { name: 'Next items' }));
    rerender(tree(rows, '2026-10-05'));
    expect(screen.getByRole('status')).toHaveTextContent('Items 1–50 of 103');
    await user.click(screen.getByRole('button', { name: 'Next items' }));
    rerender(tree(rows.slice(0, 10), '2026-10-05'));
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(rows).toHaveLength(103);
    expect(rows[0]?.title).toBe('Synthetic 1');
  });
});
