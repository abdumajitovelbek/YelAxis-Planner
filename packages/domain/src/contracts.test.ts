import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createEntityRef,
  entityRefKey,
  err,
  ok,
  parseUUID,
  type Clock,
  type CommandContext,
  type DomainChange,
  type DomainError,
  type DomainEventDraft,
  type DomainResult,
  type EntityRef,
  type IdProvider,
  type UndoDescriptorDraft,
} from './index.js';

const expectValue = <T>(result: DomainResult<T>): T => {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }

  return result.value;
};

describe('shared domain contracts', () => {
  it('accepts UUIDs and rejects malformed identifiers', () => {
    const valid = parseUUID('0190c2b1-7d9a-7cc1-8be5-b88620c57f5a');
    expect(valid.ok).toBe(true);
    expect(parseUUID('not-an-id')).toEqual({
      ok: false,
      error: {
        code: 'invalid_uuid',
        message: 'Value must be a valid UUID.',
      },
    });
  });

  it('creates stable owner-qualified entity reference keys', () => {
    const ownerId = expectValue(parseUUID('0190c2b1-7d9a-7cc1-8be5-b88620c57f5a'));
    const entityId = expectValue(parseUUID('0190c2b1-7d9a-7cc1-8be5-b88620c57f5b'));
    const ref = createEntityRef('action', entityId, ownerId);

    expect(entityRefKey(ref)).toBe(
      '0190c2b1-7d9a-7cc1-8be5-b88620c57f5a:action:0190c2b1-7d9a-7cc1-8be5-b88620c57f5b',
    );
  });

  it('keeps the application-facing contracts immutable and runtime-neutral', () => {
    expectTypeOf<Clock>().toMatchTypeOf<{ now(): string }>();
    expectTypeOf<IdProvider>().toMatchTypeOf<{ next(): string }>();
    expectTypeOf<CommandContext>().toHaveProperty('commandId');
    expectTypeOf<EntityRef>().toHaveProperty('ownerId');
    expectTypeOf<DomainEventDraft>().toHaveProperty('payload');
    expectTypeOf<UndoDescriptorDraft>().toHaveProperty('expectedRevisions');
    expectTypeOf<DomainChange<unknown>>().toHaveProperty('touched');
  });

  it('uses one result shape for accepted values and domain failures', () => {
    const failure: DomainError = {
      code: 'invalid_value',
      message: 'A value was invalid.',
      details: { field: 'title' },
    };

    expect(ok(3)).toEqual({ ok: true, value: 3 });
    expect(err(failure)).toEqual({ ok: false, error: failure });
  });
});
