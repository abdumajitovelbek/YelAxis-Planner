import { err, ok, type DomainResult } from './contracts.js';

export type AxisState = 'active' | 'archived';
export type OutcomeState = 'active' | 'paused' | 'achieved' | 'abandoned' | 'archived';
export type MilestoneState = 'active' | 'completed' | 'canceled' | 'archived';
export type ProjectState = 'idea' | 'active' | 'blocked' | 'paused' | 'completed' | 'archived';
export type ActionState =
  'inbox' | 'planned' | 'scheduled' | 'in_progress' | 'completed' | 'canceled' | 'archived';
export type NoteState = 'active' | 'archived';
export type CommitmentState = 'planned' | 'completed' | 'canceled' | 'archived';
export type TimeBlockState = 'planned' | 'completed' | 'skipped' | 'canceled';
export type RoutineState = 'active' | 'paused' | 'archived';
export type RoutineOccurrenceState = 'planned' | 'completed' | 'skipped';
export type TemplateState = 'active' | 'archived';
export type ReviewState = 'draft' | 'skipped' | 'completed' | 'archived';
export type ReminderState = 'scheduled' | 'delivered' | 'canceled';
export type ContextState = 'active' | 'archived';

export type LifecycleState =
  | AxisState
  | OutcomeState
  | MilestoneState
  | ProjectState
  | ActionState
  | NoteState
  | CommitmentState
  | TimeBlockState
  | RoutineState
  | RoutineOccurrenceState
  | TemplateState
  | ReviewState
  | ReminderState
  | ContextState;

export type LifecycleEntityType =
  | 'axis'
  | 'outcome'
  | 'milestone'
  | 'project'
  | 'action'
  | 'note'
  | 'commitment'
  | 'time_block'
  | 'routine'
  | 'routine_occurrence'
  | 'template'
  | 'review'
  | 'reminder'
  | 'context';

export type TransitionIntent = 'standard' | 'reopen_or_undo' | 'reschedule';

export interface LifecycleSnapshot {
  readonly state: LifecycleState;
  readonly stateBeforeArchive?: LifecycleState;
}

export interface LifecycleTransitionRequest {
  readonly entityType: LifecycleEntityType;
  readonly current: LifecycleSnapshot;
  readonly to: LifecycleState;
  readonly intent?: TransitionIntent;
}

interface StateMachine {
  readonly states: readonly LifecycleState[];
  readonly fallback: LifecycleState;
  readonly transitions: Readonly<Record<string, readonly LifecycleState[]>>;
}

const stateMachines: Readonly<Record<LifecycleEntityType, StateMachine>> = {
  axis: {
    states: ['active', 'archived'],
    fallback: 'active',
    transitions: { active: ['archived'] },
  },
  outcome: {
    states: ['active', 'paused', 'achieved', 'abandoned', 'archived'],
    fallback: 'active',
    transitions: {
      active: ['paused', 'achieved', 'abandoned', 'archived'],
      paused: ['active', 'achieved', 'abandoned', 'archived'],
      achieved: ['active', 'archived'],
      abandoned: ['active', 'archived'],
    },
  },
  milestone: {
    states: ['active', 'completed', 'canceled', 'archived'],
    fallback: 'active',
    transitions: {
      active: ['completed', 'canceled', 'archived'],
      completed: ['active', 'archived'],
      canceled: ['active', 'archived'],
    },
  },
  project: {
    states: ['idea', 'active', 'blocked', 'paused', 'completed', 'archived'],
    fallback: 'active',
    transitions: {
      idea: ['active', 'paused', 'archived'],
      active: ['blocked', 'paused', 'completed', 'archived'],
      blocked: ['active', 'paused', 'completed', 'archived'],
      paused: ['active', 'completed', 'archived'],
      completed: ['active', 'archived'],
    },
  },
  action: {
    states: ['inbox', 'planned', 'scheduled', 'in_progress', 'completed', 'canceled', 'archived'],
    fallback: 'planned',
    transitions: {
      inbox: ['planned', 'scheduled', 'in_progress', 'completed', 'canceled', 'archived'],
      planned: ['inbox', 'scheduled', 'in_progress', 'completed', 'canceled', 'archived'],
      scheduled: ['planned', 'in_progress', 'completed', 'canceled', 'archived'],
      in_progress: ['planned', 'scheduled', 'completed', 'canceled', 'archived'],
      completed: ['planned', 'archived'],
      canceled: ['inbox', 'planned', 'archived'],
    },
  },
  note: {
    states: ['active', 'archived'],
    fallback: 'active',
    transitions: { active: ['archived'] },
  },
  commitment: {
    states: ['planned', 'completed', 'canceled', 'archived'],
    fallback: 'planned',
    transitions: {
      planned: ['completed', 'canceled', 'archived'],
      completed: ['planned', 'archived'],
      canceled: ['planned', 'archived'],
    },
  },
  time_block: {
    states: ['planned', 'completed', 'skipped', 'canceled'],
    fallback: 'planned',
    transitions: {
      planned: ['completed', 'skipped', 'canceled'],
      completed: ['planned'],
      skipped: ['planned'],
      canceled: ['planned'],
    },
  },
  routine: {
    states: ['active', 'paused', 'archived'],
    fallback: 'active',
    transitions: { active: ['paused', 'archived'], paused: ['active', 'archived'] },
  },
  routine_occurrence: {
    states: ['planned', 'completed', 'skipped'],
    fallback: 'planned',
    transitions: {
      planned: ['completed', 'skipped'],
      completed: ['planned'],
      skipped: ['planned'],
    },
  },
  template: {
    states: ['active', 'archived'],
    fallback: 'active',
    transitions: { active: ['archived'] },
  },
  review: {
    states: ['draft', 'skipped', 'completed', 'archived'],
    fallback: 'draft',
    transitions: {
      draft: ['completed', 'skipped', 'archived'],
      skipped: ['draft', 'completed', 'archived'],
      completed: ['draft', 'archived'],
    },
  },
  reminder: {
    states: ['scheduled', 'delivered', 'canceled'],
    fallback: 'scheduled',
    transitions: {
      scheduled: ['delivered', 'canceled'],
      delivered: ['scheduled'],
      canceled: ['scheduled'],
    },
  },
  context: {
    states: ['active', 'archived'],
    fallback: 'active',
    transitions: { active: ['archived'] },
  },
};

const invalidTransition = (
  entityType: LifecycleEntityType,
  from: LifecycleState,
  to: LifecycleState,
): DomainResult<LifecycleSnapshot> =>
  err({
    code: 'invalid_transition',
    message: 'The lifecycle transition is not allowed.',
    details: { entityType, from, to },
  });

const needsExplicitIntent = (
  entityType: LifecycleEntityType,
  from: LifecycleState,
  to: LifecycleState,
  intent: TransitionIntent | undefined,
): boolean => {
  if (
    (entityType === 'time_block' || entityType === 'routine_occurrence') &&
    to === 'planned' &&
    from !== 'planned'
  ) {
    return intent !== 'reopen_or_undo';
  }

  if (entityType === 'review' && from === 'completed' && to === 'draft') {
    return intent !== 'reopen_or_undo';
  }

  if (entityType === 'reminder' && to === 'scheduled' && from !== 'scheduled') {
    return intent !== 'reschedule';
  }

  return false;
};

export const transitionLifecycle = (
  request: LifecycleTransitionRequest,
): DomainResult<LifecycleSnapshot> => {
  const machine = stateMachines[request.entityType];
  const from = request.current.state;

  if (
    !machine.states.includes(from) ||
    !machine.states.includes(request.to) ||
    from === request.to
  ) {
    return invalidTransition(request.entityType, from, request.to);
  }

  if (from === 'archived') {
    const restored = restoreLifecycle(request.entityType, request.current);
    if (!restored.ok || restored.value.state !== request.to) {
      return invalidTransition(request.entityType, from, request.to);
    }
    return restored;
  }

  if (!(machine.transitions[from]?.includes(request.to) ?? false)) {
    return invalidTransition(request.entityType, from, request.to);
  }

  if (needsExplicitIntent(request.entityType, from, request.to, request.intent)) {
    return invalidTransition(request.entityType, from, request.to);
  }

  if (request.to === 'archived') {
    return ok({ state: 'archived', stateBeforeArchive: from });
  }

  return ok({ state: request.to });
};

export const restoreLifecycle = (
  entityType: LifecycleEntityType,
  current: LifecycleSnapshot,
): DomainResult<LifecycleSnapshot> => {
  const machine = stateMachines[entityType];
  if (current.state !== 'archived' || !machine.states.includes('archived')) {
    return invalidTransition(entityType, current.state, machine.fallback);
  }

  const recorded = current.stateBeforeArchive;
  const destination =
    recorded !== undefined &&
    recorded !== 'archived' &&
    machine.states.includes(recorded) &&
    (machine.transitions[recorded]?.includes('archived') ?? false)
      ? recorded
      : machine.fallback;

  return ok({ state: destination });
};
