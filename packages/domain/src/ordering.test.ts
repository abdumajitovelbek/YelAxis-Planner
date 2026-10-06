import { describe, expect, it } from 'vitest';

import {
  appendOrderKey,
  compareOrder,
  inPlaceDistinctKeys,
  isSpacedOrderKey,
  maxOrderedItems,
  needsOrderNormalization,
  normalizeOrder,
  reorderWithin,
  spacedOrderKey,
  type DomainResult,
  type OrderedItem,
} from './index.js';

const expectValue = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const reason = (result: DomainResult<unknown>): unknown =>
  result.ok ? undefined : result.error.details?.['reason'];

/** Apply key changes and read the container back in display order. */
const orderAfter = (
  items: readonly OrderedItem[],
  changes: readonly { readonly id: string; readonly orderKey: string }[],
): string[] =>
  items
    .map((item) => ({
      ...item,
      orderKey: changes.find((change) => change.id === item.id)?.orderKey ?? item.orderKey,
    }))
    .sort(compareOrder)
    .map((item) => item.id);

const spaced = (ids: readonly string[]): OrderedItem[] =>
  ids.map((id, index) => ({ id, orderKey: spacedOrderKey(index) }));

describe('persisted order', () => {
  it('orders by key, then by id, never by input position', () => {
    const rows: OrderedItem[] = [
      { id: 'c', orderKey: '000000002000000' },
      { id: 'b', orderKey: '000000001000000' },
      { id: 'a', orderKey: '000000002000000' },
    ];
    expect([...rows].sort(compareOrder).map((row) => row.id)).toEqual(['b', 'a', 'c']);
    expect(compareOrder({ id: 'a', orderKey: 'x' }, { id: 'a', orderKey: 'x' })).toBe(0);
  });

  it('spaces keys one billion apart in the 15-digit key space', () => {
    expect(spacedOrderKey(0)).toBe('000001000000000');
    expect(spacedOrderKey(1)).toBe('000002000000000');
    expect(spacedOrderKey(maxOrderedItems - 1)).toBe('999999000000000');
    expect(isSpacedOrderKey(spacedOrderKey(41))).toBe(true);
    expect(isSpacedOrderKey('500000000000000')).toBe(true);
    for (const key of [
      'onboarding-01',
      'a',
      '',
      '12345678901234',
      '1234567890123456',
      'x'.repeat(15),
    ])
      expect(isSpacedOrderKey(key)).toBe(false);
  });

  it('needs normalization only for non-spaced or tied keys', () => {
    expect(needsOrderNormalization([])).toBe(false);
    expect(needsOrderNormalization(spaced(['a', 'b']))).toBe(false);
    expect(
      needsOrderNormalization([
        { id: 'a', orderKey: '499999999999999' },
        { id: 'b', orderKey: '500000000000000' },
      ]),
    ).toBe(false);
    expect(needsOrderNormalization([{ id: 'a', orderKey: 'onboarding-01' }])).toBe(true);
    expect(
      needsOrderNormalization([
        { id: 'a', orderKey: spacedOrderKey(0) },
        { id: 'b', orderKey: spacedOrderKey(0) },
      ]),
    ).toBe(true);
  });

  it('normalizes to spaced keys in the current order and reports only changed rows', () => {
    const rows: OrderedItem[] = [
      { id: 'b', orderKey: 'onboarding-02' },
      { id: 'a', orderKey: 'onboarding-01' },
      { id: 'c', orderKey: spacedOrderKey(2) },
    ];
    const changes = normalizeOrder(rows);
    expect(changes).toEqual([
      { id: 'c', orderKey: spacedOrderKey(0) },
      { id: 'a', orderKey: spacedOrderKey(1) },
      { id: 'b', orderKey: spacedOrderKey(2) },
    ]);
    expect(normalizeOrder(spaced(['a', 'b']))).toEqual([]);
  });
});

describe('reorderWithin', () => {
  it('swaps only the moving row and its neighbor when keys are already spaced', () => {
    const rows = spaced(['a', 'b', 'c']);
    const up = expectValue(reorderWithin(rows, 'c', 'up'));
    expect(up).toEqual([
      { id: 'b', orderKey: spacedOrderKey(2) },
      { id: 'c', orderKey: spacedOrderKey(1) },
    ]);
    expect(orderAfter(rows, up)).toEqual(['a', 'c', 'b']);
    const down = expectValue(reorderWithin(rows, 'a', 'down'));
    expect(orderAfter(rows, down)).toEqual(['b', 'a', 'c']);
    expect(down).toHaveLength(2);
  });

  it('keeps unspaced but distinct 15-digit keys and still swaps them', () => {
    const rows: OrderedItem[] = [
      { id: 'a', orderKey: '499999999999999' },
      { id: 'b', orderKey: '500000000000000' },
    ];
    expect(expectValue(reorderWithin(rows, 'b', 'up'))).toEqual([
      { id: 'a', orderKey: '500000000000000' },
      { id: 'b', orderKey: '499999999999999' },
    ]);
  });

  it('normalizes onboarding keys in the same change set before swapping', () => {
    const rows: OrderedItem[] = [
      { id: 'health', orderKey: 'onboarding-00' },
      { id: 'work', orderKey: 'onboarding-01' },
      { id: 'family', orderKey: 'onboarding-02' },
    ];
    const changes = expectValue(reorderWithin(rows, 'family', 'up'));
    expect(orderAfter(rows, changes)).toEqual(['health', 'family', 'work']);
    expect(changes).toEqual([
      { id: 'health', orderKey: spacedOrderKey(0) },
      { id: 'work', orderKey: spacedOrderKey(2) },
      { id: 'family', orderKey: spacedOrderKey(1) },
    ]);
    expect(changes.every((change) => isSpacedOrderKey(change.orderKey))).toBe(true);
  });

  it('breaks ties by id, then normalizes so the move is visible', () => {
    const tied = spacedOrderKey(0);
    const rows: OrderedItem[] = [
      { id: 'b', orderKey: tied },
      { id: 'a', orderKey: tied },
      { id: 'c', orderKey: tied },
    ];
    const changes = expectValue(reorderWithin(rows, 'b', 'up'));
    expect(orderAfter(rows, changes)).toEqual(['b', 'a', 'c']);
    expect(new Set(changes.map((change) => change.orderKey)).size).toBe(changes.length);
  });

  it('breaks ties in place for containers that share keys with a wider list', () => {
    const tied = '500000000000000';
    const rows: OrderedItem[] = [
      { id: 'b', orderKey: tied },
      { id: 'a', orderKey: tied },
      { id: 'c', orderKey: '500000000000007' },
    ];
    expect(inPlaceDistinctKeys([...rows].sort(compareOrder))).toEqual([
      '500000000000000',
      '500000000000001',
      '500000000000007',
    ]);
    const changes = expectValue(reorderWithin(rows, 'b', 'up', 'in_place'));
    expect(orderAfter(rows, changes)).toEqual(['b', 'a', 'c']);
    for (const change of changes) {
      expect(Number(change.orderKey)).toBeGreaterThanOrEqual(Number(tied));
      expect(Number(change.orderKey)).toBeLessThan(Number(tied) + 10);
    }
  });

  it('refuses edges, missing rows, duplicate ids, and unknown directions', () => {
    const rows = spaced(['a', 'b']);
    expect(reason(reorderWithin(rows, 'a', 'up'))).toBe('order_edge');
    expect(reason(reorderWithin(rows, 'b', 'down'))).toBe('order_edge');
    expect(reason(reorderWithin(rows, 'z', 'up'))).toBe('order_target');
    expect(reason(reorderWithin([...rows, { id: 'a', orderKey: 'x' }], 'b', 'up'))).toBe(
      'order_items',
    );
    expect(reason(reorderWithin(rows, 'b', 'left' as 'up'))).toBe('direction');
    const edge = reorderWithin(rows, 'a', 'up');
    expect(edge).toMatchObject({ ok: false, error: { code: 'invalid_value' } });
  });
});

describe('appendOrderKey', () => {
  it('starts an empty container at the first spaced key', () => {
    expect(expectValue(appendOrderKey([]))).toEqual({ orderKey: spacedOrderKey(0), changes: [] });
  });

  it('appends one step after the largest key without touching existing rows', () => {
    expect(expectValue(appendOrderKey(spaced(['a', 'b'])))).toEqual({
      orderKey: spacedOrderKey(2),
      changes: [],
    });
    expect(
      expectValue(
        appendOrderKey([
          { id: 'a', orderKey: '500000000000000' },
          { id: 'b', orderKey: '499999999999999' },
        ]),
      ),
    ).toEqual({ orderKey: '500001000000000', changes: [] });
  });

  it('normalizes onboarding keys so the new row sorts last', () => {
    const rows: OrderedItem[] = [
      { id: 'a', orderKey: 'onboarding-00' },
      { id: 'b', orderKey: 'onboarding-01' },
    ];
    const appended = expectValue(appendOrderKey(rows));
    expect(appended.changes).toEqual([
      { id: 'a', orderKey: spacedOrderKey(0) },
      { id: 'b', orderKey: spacedOrderKey(1) },
    ]);
    expect(
      orderAfter([...rows, { id: 'new', orderKey: appended.orderKey }], appended.changes),
    ).toEqual(['a', 'b', 'new']);
  });

  it('normalizes when the largest key leaves no room', () => {
    const rows: OrderedItem[] = [
      { id: 'a', orderKey: '000001000000000' },
      { id: 'b', orderKey: '999999500000000' },
    ];
    const appended = expectValue(appendOrderKey(rows));
    expect(appended.orderKey).toBe(spacedOrderKey(2));
    expect(appended.changes).toEqual([{ id: 'b', orderKey: spacedOrderKey(1) }]);
  });

  it('normalizes ties and refuses duplicate ids', () => {
    const tied = expectValue(
      appendOrderKey([
        { id: 'b', orderKey: spacedOrderKey(0) },
        { id: 'a', orderKey: spacedOrderKey(0) },
      ]),
    );
    expect(tied).toEqual({
      orderKey: spacedOrderKey(2),
      changes: [{ id: 'b', orderKey: spacedOrderKey(1) }],
    });
    expect(
      reason(
        appendOrderKey([
          { id: 'a', orderKey: spacedOrderKey(0) },
          { id: 'a', orderKey: spacedOrderKey(1) },
        ]),
      ),
    ).toBe('order_items');
  });
});
