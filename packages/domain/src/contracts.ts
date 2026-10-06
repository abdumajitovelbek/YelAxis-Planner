declare const domainBrand: unique symbol;

export type Brand<Value, Name extends string> = Value & {
  readonly [domainBrand]: Name;
};

export type UUID = Brand<string, 'UUID'>;
export type EntityId = UUID;
export type OwnerId = UUID;
export type CommandId = UUID;
export type ProfileId = UUID;

export type DomainErrorCode =
  | 'invalid_uuid'
  | 'invalid_value'
  | 'invalid_transition'
  | 'invalid_time'
  | 'invalid_time_zone'
  | 'invalid_interval'
  | 'invalid_target_window'
  | 'invalid_recurrence'
  | 'owner_mismatch'
  | 'archived_endpoint'
  | 'unsupported_relationship'
  | 'cross_axis_confirmation_required'
  | 'cardinality_violation'
  | 'required_relationship'
  | 'placement_not_allowed'
  | 'selection_limit'
  | 'delete_restricted';

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type DomainResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: DomainError };

export const ok = <Value>(value: Value): DomainResult<Value> => ({ ok: true, value });

export const err = <Value = never>(error: DomainError): DomainResult<Value> => ({
  ok: false,
  error,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const parseUUID = (value: string): DomainResult<UUID> => {
  if (!UUID_PATTERN.test(value)) {
    return err({
      code: 'invalid_uuid',
      message: 'Value must be a valid UUID.',
    });
  }

  return ok(value.toLowerCase() as UUID);
};

export type CommandActor = 'user' | 'import' | 'sync' | 'intelligence_proposal';

export type EntityType =
  | 'profile'
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
  | 'routine_action_defaults'
  | 'template'
  | 'review'
  | 'review_item'
  | 'reminder'
  | 'context'
  | 'constraint'
  | 'planning_placement'
  | 'focus_selection'
  | 'theme'
  | 'direction'
  /** Typed join records: a Project supporting an Outcome, a Milestone's Project or Action. */
  | 'project_secondary_outcome'
  | 'milestone_project'
  | 'milestone_action';

export type EntityRef<Type extends EntityType = EntityType> = Readonly<{
  type: Type;
  id: EntityId;
  ownerId: OwnerId;
}>;

export type EntityRefKey = Brand<string, 'EntityRefKey'>;

export const createEntityRef = <Type extends EntityType>(
  type: Type,
  id: EntityId,
  ownerId: OwnerId,
): EntityRef<Type> => ({ type, id, ownerId });

export const entityRefKey = (reference: EntityRef): EntityRefKey =>
  `${reference.ownerId}:${reference.type}:${reference.id}` as EntityRefKey;

/** Canonical UTC instant. Runtime construction is provided by parseInstant. */
export type Instant = Brand<string, 'Instant'>;

export interface CommandContext {
  readonly ownerId: OwnerId;
  readonly actor: CommandActor;
  readonly commandId: CommandId;
  readonly now: Instant;
}

export interface DomainEventDraft {
  readonly aggregate: EntityRef;
  readonly eventType: string;
  readonly version: 1;
  readonly actor: CommandActor;
  readonly commandId: CommandId;
  readonly occurredAt: Instant;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface UndoDescriptorDraft {
  readonly commandType: string;
  readonly version: 1;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly expectedRevisions: Readonly<Record<EntityRefKey, number>>;
}

export interface DomainChange<Value> {
  readonly value: Value;
  readonly events: readonly DomainEventDraft[];
  readonly undo?: UndoDescriptorDraft;
  readonly touched: readonly EntityRef[];
}

export interface Clock {
  now(): Instant;
}

export interface IdProvider {
  next(): UUID;
}
