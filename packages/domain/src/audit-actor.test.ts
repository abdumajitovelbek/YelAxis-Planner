import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  CommandActor,
  CommandContext,
  CommandId,
  DomainEventDraft,
  EntityRef,
  Instant,
  OwnerId,
} from './index.js';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const commandId = '30000000-0000-4000-8000-000000000001' as CommandId;
const now = '2026-10-01T09:00:00.000Z' as Instant;
const aggregate: EntityRef<'action'> = {
  type: 'action',
  id: '20000000-0000-4000-8000-000000000001' as EntityRef['id'],
  ownerId,
};

describe('command audit actors', () => {
  it('reserves intelligence_proposal beside the manual, import, and sync actors', () => {
    expectTypeOf<CommandActor>().toEqualTypeOf<
      'user' | 'import' | 'sync' | 'intelligence_proposal'
    >();
  });

  it('preserves the reserved audit actor through a normal command context', () => {
    const context: CommandContext = { ownerId, actor: 'intelligence_proposal', commandId, now };
    const event: DomainEventDraft = {
      aggregate,
      eventType: 'action.created',
      version: 1,
      actor: context.actor,
      commandId: context.commandId,
      occurredAt: context.now,
      payload: { operation: 'create' },
    };

    expect(event.actor).toBe('intelligence_proposal');
    expect(Object.keys(event.payload)).toEqual(['operation']);
  });
});
