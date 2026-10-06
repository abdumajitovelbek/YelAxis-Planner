import { describe, expect, it } from 'vitest';

import {
  restoreLifecycle,
  transitionLifecycle,
  type DomainResult,
  type LifecycleEntityType,
  type LifecycleState,
} from './index.js';

const expectAccepted = (result: DomainResult<unknown>): void => {
  expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
};

const expectRejected = (result: DomainResult<unknown>): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe('invalid_transition');
  }
};

const legalTransitions: Readonly<
  Record<LifecycleEntityType, Readonly<Record<string, readonly LifecycleState[]>>>
> = {
  axis: { active: ['archived'] },
  outcome: {
    active: ['paused', 'achieved', 'abandoned', 'archived'],
    paused: ['active', 'achieved', 'abandoned', 'archived'],
    achieved: ['active', 'archived'],
    abandoned: ['active', 'archived'],
  },
  milestone: {
    active: ['completed', 'canceled', 'archived'],
    completed: ['active', 'archived'],
    canceled: ['active', 'archived'],
  },
  project: {
    idea: ['active', 'paused', 'archived'],
    active: ['blocked', 'paused', 'completed', 'archived'],
    blocked: ['active', 'paused', 'completed', 'archived'],
    paused: ['active', 'completed', 'archived'],
    completed: ['active', 'archived'],
  },
  action: {
    inbox: ['planned', 'scheduled', 'in_progress', 'completed', 'canceled', 'archived'],
    planned: ['inbox', 'scheduled', 'in_progress', 'completed', 'canceled', 'archived'],
    scheduled: ['planned', 'in_progress', 'completed', 'canceled', 'archived'],
    in_progress: ['planned', 'scheduled', 'completed', 'canceled', 'archived'],
    completed: ['planned', 'archived'],
    canceled: ['inbox', 'planned', 'archived'],
  },
  note: { active: ['archived'] },
  commitment: {
    planned: ['completed', 'canceled', 'archived'],
    completed: ['planned', 'archived'],
    canceled: ['planned', 'archived'],
  },
  time_block: {
    planned: ['completed', 'skipped', 'canceled'],
    completed: ['planned'],
    skipped: ['planned'],
    canceled: ['planned'],
  },
  routine: { active: ['paused', 'archived'], paused: ['active', 'archived'] },
  routine_occurrence: {
    planned: ['completed', 'skipped'],
    completed: ['planned'],
    skipped: ['planned'],
  },
  template: { active: ['archived'] },
  review: {
    draft: ['completed', 'skipped', 'archived'],
    skipped: ['draft', 'completed', 'archived'],
    completed: ['draft', 'archived'],
  },
  reminder: {
    scheduled: ['delivered', 'canceled'],
    delivered: ['scheduled'],
    canceled: ['scheduled'],
  },
  context: { active: ['archived'] },
};

const explicitIntent = (
  entityType: LifecycleEntityType,
  from: string,
  to: string,
): 'standard' | 'reopen_or_undo' | 'reschedule' => {
  if (
    to === 'planned' &&
    (entityType === 'time_block' || entityType === 'routine_occurrence') &&
    from !== 'planned'
  ) {
    return 'reopen_or_undo';
  }

  if (entityType === 'review' && from === 'completed' && to === 'draft') {
    return 'reopen_or_undo';
  }

  if (entityType === 'reminder' && to === 'scheduled' && from !== 'scheduled') {
    return 'reschedule';
  }

  return 'standard';
};

describe('lifecycle state graphs', () => {
  it('accepts every specified non-restore edge', () => {
    for (const [entityType, states] of Object.entries(legalTransitions)) {
      for (const [from, destinations] of Object.entries(states)) {
        for (const to of destinations) {
          expectAccepted(
            transitionLifecycle({
              entityType: entityType as LifecycleEntityType,
              current: { state: from as LifecycleState },
              to,
              intent: explicitIntent(entityType as LifecycleEntityType, from, to),
            }),
          );
        }
      }
    }
  });

  it('rejects representative shortcuts and same-state writes', () => {
    expectRejected(
      transitionLifecycle({ entityType: 'project', current: { state: 'idea' }, to: 'completed' }),
    );
    expectRejected(
      transitionLifecycle({ entityType: 'action', current: { state: 'completed' }, to: 'inbox' }),
    );
    expectRejected(
      transitionLifecycle({ entityType: 'routine', current: { state: 'active' }, to: 'active' }),
    );
  });

  it('requires explicit reopen or reschedule intent for protected reverse edges', () => {
    expectRejected(
      transitionLifecycle({
        entityType: 'time_block',
        current: { state: 'completed' },
        to: 'planned',
      }),
    );
    expectRejected(
      transitionLifecycle({
        entityType: 'routine_occurrence',
        current: { state: 'skipped' },
        to: 'planned',
      }),
    );
    expectRejected(
      transitionLifecycle({
        entityType: 'review',
        current: { state: 'completed' },
        to: 'draft',
      }),
    );
    expectRejected(
      transitionLifecycle({
        entityType: 'reminder',
        current: { state: 'delivered' },
        to: 'scheduled',
      }),
    );
  });

  it('archives without cascading and restores the recorded prior state', () => {
    const archived = transitionLifecycle({
      entityType: 'action',
      current: { state: 'in_progress' },
      to: 'archived',
    });
    expect(archived).toEqual({
      ok: true,
      value: { state: 'archived', stateBeforeArchive: 'in_progress' },
    });

    if (!archived.ok) throw new Error('expected archive to succeed');
    expect(restoreLifecycle('action', archived.value)).toEqual({
      ok: true,
      value: { state: 'in_progress' },
    });
  });

  it('uses the safest active state when legacy archive metadata is missing or invalid', () => {
    expect(restoreLifecycle('project', { state: 'archived' })).toEqual({
      ok: true,
      value: { state: 'active' },
    });
    expect(
      restoreLifecycle('project', { state: 'archived', stateBeforeArchive: 'delivered' }),
    ).toEqual({ ok: true, value: { state: 'active' } });
  });
});
