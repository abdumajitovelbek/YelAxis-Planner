import { describe, expect, it } from 'vitest';

import {
  createInboxOrderKey,
  normalizeActionInput,
  parseCalendarDate,
  parseIanaTimeZone,
  resolveActionReminder,
  type Instant,
} from './index';

describe('Action capture policy', () => {
  it.each([
    null,
    [],
    { title: 42 },
    { title: 'Synthetic', note: [] },
    { title: 'Synthetic', ownerId: 'unexpected' },
  ])('rejects malformed runtime fields without throwing (%#)', (input) => {
    expect(normalizeActionInput(input as Parameters<typeof normalizeActionInput>[0])).toMatchObject(
      { ok: false },
    );
  });
  it('normalizes optional fields and rejects unsafe bounds and enum values', () => {
    expect(
      normalizeActionInput({
        title: '  Call Sam  ',
        note: '  Confirm Tuesday  ',
        estimateMinutes: 30,
        energy: 'medium',
        priority: 'high',
      }),
    ).toEqual({
      ok: true,
      value: {
        title: 'Call Sam',
        note: 'Confirm Tuesday',
        estimateMinutes: 30,
        energy: 'medium',
        priority: 'high',
      },
    });
    expect(normalizeActionInput({ title: '   ' })).toMatchObject({ ok: false });
    expect(normalizeActionInput({ title: 'x'.repeat(201) })).toMatchObject({ ok: false });
    expect(normalizeActionInput({ title: 'x', estimateMinutes: 0 })).toMatchObject({ ok: false });
    expect(normalizeActionInput({ title: 'x', energy: 'urgent' })).toMatchObject({ ok: false });
  });

  it('accepts exact Unicode, note, estimate, and energy boundaries without inventing values', () => {
    const title = '界'.repeat(200);
    const note = 'n'.repeat(10_000);
    expect(
      normalizeActionInput({ title, note, estimateMinutes: 10_080, energy: 'focused' }),
    ).toEqual({
      ok: true,
      value: { title, note, estimateMinutes: 10_080, energy: 'focused' },
    });
    expect(normalizeActionInput({ title: 'x', note: 'n'.repeat(10_001) })).toMatchObject({
      ok: false,
    });
    expect(normalizeActionInput({ title: 'x', estimateMinutes: 10_081 })).toMatchObject({
      ok: false,
    });
    expect(normalizeActionInput({ title: 'x', note: '   ' })).toEqual({
      ok: true,
      value: { title: 'x' },
    });
  });

  it('creates fixed-width keys above or below the current edge without key growth', () => {
    expect(createInboxOrderKey()).toEqual({ ok: true, value: '500000000000000' });
    expect(createInboxOrderKey('500000000000000', 'before')).toEqual({
      ok: true,
      value: '499999999999999',
    });
    expect(createInboxOrderKey('500000000000000', 'after')).toEqual({
      ok: true,
      value: '500000000000001',
    });
    expect(createInboxOrderKey('000000000000000', 'before')).toMatchObject({ ok: false });
    expect(createInboxOrderKey('999999999999999', 'after')).toMatchObject({ ok: false });
    expect(createInboxOrderKey('not-a-key')).toMatchObject({ ok: false });
  });
});

describe('Action reminder policy', () => {
  const zone = parseIanaTimeZone('America/New_York');
  const date = parseCalendarDate('2026-11-01');

  it('resolves absolute wall time through explicit overlap policy', () => {
    if (!zone.ok || !date.ok) throw new Error('fixture parsing failed');
    expect(
      resolveActionReminder({
        kind: 'at',
        date: date.value,
        wallTime: '01:30',
        timeZone: zone.value,
        gapPolicy: 'shift_forward',
        overlapPolicy: 'later_offset',
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: 'at',
        remindAt: '2026-11-01T06:30:00.000Z',
        timeZone: zone.value,
      },
    });
  });

  it('stores a relative definition and its resolved instant', () => {
    if (!zone.ok) throw new Error('fixture parsing failed');
    expect(
      resolveActionReminder({
        kind: 'relative',
        anchor: '2026-11-01T08:00:00.000Z' as Instant,
        offsetMinutes: 30,
        timeZone: zone.value,
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: 'relative',
        remindAt: '2026-11-01T07:30:00.000Z',
        offsetMinutes: -30,
        timeZone: zone.value,
      },
    });
    expect(
      resolveActionReminder({
        kind: 'relative',
        anchor: '2026-11-01T08:00:00.000Z' as Instant,
        offsetMinutes: -1,
        timeZone: zone.value,
      }),
    ).toMatchObject({ ok: false });
    expect(
      resolveActionReminder({
        kind: 'relative',
        anchor: '2026-11-01T08:00:00.000Z' as Instant,
        offsetMinutes: 10_081,
        timeZone: zone.value,
      }),
    ).toMatchObject({ ok: false });
  });
});
