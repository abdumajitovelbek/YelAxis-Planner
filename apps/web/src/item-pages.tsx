import { useId, useState, type ReactNode } from 'react';

import { message as uiMessage, uiLocale } from './messages';

export const visibleItemPageSize = 50;

/** Presentation only: full source rows still govern ordering, capacity, conflicts and commands. */
export function useItemPage<Item>(items: readonly Item[], identity?: string) {
  const [selection, setSelection] = useState({ identity, index: 0 });
  const last = Math.max(0, Math.ceil(items.length / visibleItemPageSize) - 1);
  const index = selection.identity === identity ? Math.min(selection.index, last) : 0;
  const start = index * visibleItemPageSize;
  return {
    items: items.slice(start, start + visibleItemPageSize),
    start,
    total: items.length,
    index,
    last,
    select: (next: number) => setSelection({ identity, index: Math.max(0, Math.min(next, last)) }),
  };
}

export function ItemPageControls({
  page,
}: {
  readonly page: ReturnType<typeof useItemPage>;
}): ReactNode {
  const id = useId();
  if (page.total <= visibleItemPageSize) return null;
  const number = (value: number) => new Intl.NumberFormat(uiLocale).format(value);
  return (
    <div className="item-pagination" role="group" aria-labelledby={id}>
      <p id={id} role="status">
        {uiMessage('pagination.range', {
          start: number(page.start + 1),
          end: number(page.start + page.items.length),
          total: number(page.total),
        })}
      </p>
      <div className="control-row">
        <button
          type="button"
          aria-disabled={page.index === 0}
          onClick={() => page.index > 0 && page.select(page.index - 1)}
        >
          {uiMessage('pagination.previous')}
        </button>
        <button
          type="button"
          aria-disabled={page.index === page.last}
          onClick={() => page.index < page.last && page.select(page.index + 1)}
        >
          {uiMessage('pagination.next')}
        </button>
      </div>
    </div>
  );
}

/** Used inside ul/ol. Its controls remain focusable when the final page is reached. */
export function PagedItems<Item>({
  items,
  identity,
  children,
}: {
  readonly items: readonly Item[];
  readonly identity?: string;
  readonly children: (item: Item, absoluteIndex: number) => ReactNode;
}): ReactNode {
  const page = useItemPage(items, identity);
  return (
    <>
      {page.items.map((item, index) => children(item, page.start + index))}
      {page.total > visibleItemPageSize && (
        <li className="item-pagination-row">
          <ItemPageControls page={page} />
        </li>
      )}
    </>
  );
}
