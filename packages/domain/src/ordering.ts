import { err, ok, type DomainResult } from './contracts.js';

/**
 * Persisted, scoped ordering (placement contract "Ordering and selections"). Rows of one container
 * sort by their order key and then by stable id. Reordering changes only order keys; moving to
 * another container is a separate named command.
 */
export interface OrderedItem {
  readonly id: string;
  readonly orderKey: string;
}

/** The new order key for one row of the container. */
export interface OrderKeyChange {
  readonly id: string;
  readonly orderKey: string;
}

const orderKeyWidth = 15;
const orderKeyStep = 1_000_000_000;
const spacedKeyPattern = /^\d{15}$/u;

/** The largest container whose rows can all receive distinct 15-digit spaced keys. */
export const maxOrderedItems = 999_999;

/** Deterministic total order: order key, then id (ties never depend on storage order). */
export const compareOrder = (left: OrderedItem, right: OrderedItem): number => {
  if (left.orderKey !== right.orderKey) return left.orderKey < right.orderKey ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
};

/** Distinct sortable 15-digit keys, one billion apart, for list position `index` (0-based). */
export const spacedOrderKey = (index: number): string =>
  String((index + 1) * orderKeyStep).padStart(orderKeyWidth, '0');

/** Whether a key is in the 15-digit decimal key space every new alignment key uses. */
export const isSpacedOrderKey = (key: string): boolean => spacedKeyPattern.test(key);

/**
 * A container needs normalization when any key is outside the 15-digit key space (for example the
 * onboarding `onboarding-NN` keys) or when two rows share a key, because a swap or an append could
 * then fail to express the intended order.
 */
export const needsOrderNormalization = (items: readonly OrderedItem[]): boolean => {
  const seen = new Set<string>();
  for (const item of items) {
    if (!isSpacedOrderKey(item.orderKey) || seen.has(item.orderKey)) return true;
    seen.add(item.orderKey);
  }
  return false;
};

const orderError = (reason: string, message: string): DomainResult<never> =>
  err({ code: 'invalid_value', message, details: { reason } });

const sortedUnique = (items: readonly OrderedItem[]): DomainResult<readonly OrderedItem[]> => {
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    return orderError('order_items', 'This list could not be reordered. Refresh it and try again.');
  }
  if (items.length > maxOrderedItems) {
    return orderError('order_key_exhausted', 'This list is too long to reorder.');
  }
  return ok([...items].sort(compareOrder));
};

/** Rewrite a container to spaced keys in its current order; returns only the rows that change. */
export const normalizeOrder = (items: readonly OrderedItem[]): readonly OrderKeyChange[] =>
  [...items]
    .sort(compareOrder)
    .map((item, index) => ({
      id: item.id,
      orderKey: spacedOrderKey(index),
      current: item.orderKey,
    }))
    .filter((row) => row.orderKey !== row.current)
    .map(({ id, orderKey }) => ({ id, orderKey }));

/**
 * Distinct increasing 15-digit keys that keep each row at, or just after, its current key. Used when
 * a container shares its keys with a wider list (Project Actions use the Actions' Inbox/Backlog
 * keys): breaking ties this way never moves a row to another region of that wider list.
 */
export const inPlaceDistinctKeys = (sorted: readonly OrderedItem[]): readonly string[] => {
  let previous = -1;
  return sorted.map((row) => {
    const current = isSpacedOrderKey(row.orderKey) ? Number(row.orderKey) : previous + 1;
    const next = Math.max(current, previous + 1);
    previous = next;
    return String(next).padStart(orderKeyWidth, '0');
  });
};

/** How a container with non-spaced or tied keys is normalized before a move. */
export type OrderNormalization = 'spaced' | 'in_place';

/**
 * Move one row up or down by swapping keys with its neighbor. When the container has non-spaced or
 * tied keys, the whole container is first normalized in the same change set (to spaced keys, or
 * `in_place` for containers that share keys with a wider list), so the caller commits every
 * returned change in one command. Returns only rows whose key changes.
 */
export const reorderWithin = (
  items: readonly OrderedItem[],
  id: string,
  direction: 'up' | 'down',
  normalization: OrderNormalization = 'spaced',
): DomainResult<readonly OrderKeyChange[]> => {
  if (direction !== 'up' && direction !== 'down') {
    return orderError('direction', 'Choose Move up or Move down.');
  }
  const sorted = sortedUnique(items);
  if (!sorted.ok) return sorted;
  const rows = sorted.value;
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) {
    return orderError(
      'order_target',
      'This item is no longer in that list. Refresh it and try again.',
    );
  }
  const neighborIndex = direction === 'up' ? index - 1 : index + 1;
  const moving = rows[index];
  const neighbor = rows[neighborIndex];
  if (moving === undefined || neighbor === undefined) {
    return orderError(
      'order_edge',
      direction === 'up' ? 'It is already first in this list.' : 'It is already last in this list.',
    );
  }
  const normalize = needsOrderNormalization(rows);
  const keys = !normalize
    ? rows.map((row) => row.orderKey)
    : normalization === 'in_place'
      ? [...inPlaceDistinctKeys(rows)]
      : rows.map((_, position) => spacedOrderKey(position));
  const movingKey = keys[index];
  const neighborKey = keys[neighborIndex];
  if (movingKey === undefined || neighborKey === undefined) {
    return orderError('order_edge', 'This item cannot move further.');
  }
  keys[index] = neighborKey;
  keys[neighborIndex] = movingKey;
  return ok(
    rows
      .map((row, position) => ({ id: row.id, orderKey: keys[position] ?? row.orderKey }))
      .filter((change, position) => change.orderKey !== rows[position]?.orderKey),
  );
};

export interface AppendedOrder {
  /** Key for the new last row. */
  readonly orderKey: string;
  /** Normalization of existing rows that must be committed in the same command (usually none). */
  readonly changes: readonly OrderKeyChange[];
}

/**
 * The key that places a new row last in its container. Existing rows keep their keys unless the
 * container has non-spaced or tied keys, or its largest key leaves no room; then the container is
 * normalized in the same change set.
 */
export const appendOrderKey = (items: readonly OrderedItem[]): DomainResult<AppendedOrder> => {
  const sorted = sortedUnique(items);
  if (!sorted.ok) return sorted;
  const rows = sorted.value;
  if (rows.length >= maxOrderedItems) {
    return orderError('order_key_exhausted', 'This list is too long to add another item.');
  }
  const last = rows.at(-1);
  if (last === undefined) return ok({ orderKey: spacedOrderKey(0), changes: [] });
  if (!needsOrderNormalization(rows)) {
    const next = Number(last.orderKey) + orderKeyStep;
    if (Number.isSafeInteger(next) && String(next).length <= orderKeyWidth) {
      return ok({ orderKey: String(next).padStart(orderKeyWidth, '0'), changes: [] });
    }
  }
  return ok({ orderKey: spacedOrderKey(rows.length), changes: normalizeOrder(rows) });
};
