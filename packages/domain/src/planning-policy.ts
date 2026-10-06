import { Temporal } from '@js-temporal/polyfill';

import {
  createEntityRef,
  entityRefKey,
  err,
  ok,
  parseUUID,
  type DomainResult,
  type EntityId,
  type EntityRef,
  type EntityRefKey,
  type IdProvider,
  type Instant,
  type OwnerId,
} from './contracts.js';
import type { PlacementTarget } from './entities.js';
import type { ActionState } from './states.js';
import {
  createWeekPeriod,
  parseCalendarDate,
  type DayPeriod,
  type HorizonPeriod,
  type WeekPeriod,
} from './time.js';

export type TypedRelationship =
  | {
      readonly kind: 'axis_outcome';
      readonly axis: EntityRef<'axis'>;
      readonly outcome: EntityRef<'outcome'>;
    }
  | {
      readonly kind: 'axis_project';
      readonly axis: EntityRef<'axis'>;
      readonly project: EntityRef<'project'>;
    }
  | {
      readonly kind: 'axis_routine';
      readonly axis: EntityRef<'axis'>;
      readonly routine: EntityRef<'routine'>;
    }
  | {
      readonly kind: 'axis_action';
      readonly axis: EntityRef<'axis'>;
      readonly action: EntityRef<'action'>;
    }
  | {
      readonly kind: 'axis_note';
      readonly axis: EntityRef<'axis'>;
      readonly note: EntityRef<'note'>;
    }
  | {
      readonly kind: 'outcome_milestone';
      readonly outcome: EntityRef<'outcome'>;
      readonly milestone: EntityRef<'milestone'>;
    }
  | {
      readonly kind: 'outcome_primary_project';
      readonly outcome: EntityRef<'outcome'>;
      readonly project: EntityRef<'project'>;
    }
  | {
      readonly kind: 'outcome_secondary_project';
      readonly outcome: EntityRef<'outcome'>;
      readonly project: EntityRef<'project'>;
    }
  | {
      readonly kind: 'project_action';
      readonly project: EntityRef<'project'>;
      readonly action: EntityRef<'action'>;
    }
  | {
      readonly kind: 'project_note';
      readonly project: EntityRef<'project'>;
      readonly note: EntityRef<'note'>;
    }
  | {
      readonly kind: 'routine_defaults_project';
      readonly defaults: EntityRef<'routine_action_defaults'>;
      readonly project: EntityRef<'project'>;
    }
  | {
      readonly kind: 'milestone_project';
      readonly milestone: EntityRef<'milestone'>;
      readonly project: EntityRef<'project'>;
    }
  | {
      readonly kind: 'milestone_action';
      readonly milestone: EntityRef<'milestone'>;
      readonly action: EntityRef<'action'>;
    };

export type RelationshipKey = string;

const relationshipKinds: readonly TypedRelationship['kind'][] = [
  'axis_outcome',
  'axis_project',
  'axis_routine',
  'axis_action',
  'axis_note',
  'outcome_milestone',
  'outcome_primary_project',
  'outcome_secondary_project',
  'project_action',
  'project_note',
  'routine_defaults_project',
  'milestone_project',
  'milestone_action',
];

const relationshipEndpoints = (
  relationship: TypedRelationship,
): readonly [EntityRef, EntityRef] => {
  switch (relationship.kind) {
    case 'axis_outcome':
      return [relationship.axis, relationship.outcome];
    case 'axis_project':
      return [relationship.axis, relationship.project];
    case 'axis_routine':
      return [relationship.axis, relationship.routine];
    case 'axis_action':
      return [relationship.axis, relationship.action];
    case 'axis_note':
      return [relationship.axis, relationship.note];
    case 'outcome_milestone':
      return [relationship.outcome, relationship.milestone];
    case 'outcome_primary_project':
    case 'outcome_secondary_project':
      return [relationship.outcome, relationship.project];
    case 'project_action':
      return [relationship.project, relationship.action];
    case 'project_note':
      return [relationship.project, relationship.note];
    case 'routine_defaults_project':
      return [relationship.defaults, relationship.project];
    case 'milestone_project':
      return [relationship.milestone, relationship.project];
    case 'milestone_action':
      return [relationship.milestone, relationship.action];
  }
};

const endpointTypesAreValid = (relationship: TypedRelationship): boolean => {
  const [left, right] = relationshipEndpoints(relationship);
  const expected: Readonly<Record<TypedRelationship['kind'], readonly [string, string]>> = {
    axis_outcome: ['axis', 'outcome'],
    axis_project: ['axis', 'project'],
    axis_routine: ['axis', 'routine'],
    axis_action: ['axis', 'action'],
    axis_note: ['axis', 'note'],
    outcome_milestone: ['outcome', 'milestone'],
    outcome_primary_project: ['outcome', 'project'],
    outcome_secondary_project: ['outcome', 'project'],
    project_action: ['project', 'action'],
    project_note: ['project', 'note'],
    routine_defaults_project: ['routine_action_defaults', 'project'],
    milestone_project: ['milestone', 'project'],
    milestone_action: ['milestone', 'action'],
  };
  const pair = expected[relationship.kind];
  return (
    typeof left === 'object' &&
    left !== null &&
    typeof right === 'object' &&
    right !== null &&
    left.type === pair[0] &&
    right.type === pair[1] &&
    parseUUID(left.id).ok &&
    parseUUID(left.ownerId).ok &&
    parseUUID(right.id).ok &&
    parseUUID(right.ownerId).ok
  );
};

export const relationshipKey = (relationship: TypedRelationship): RelationshipKey => {
  const [left, right] = relationshipEndpoints(relationship);
  return `${entityRefKey(left)}:${relationship.kind}:${entityRefKey(right)}`;
};

export interface ValidateRelationshipLinkInput {
  readonly relationship: TypedRelationship;
  readonly existingRelationshipKeys?: readonly RelationshipKey[];
  readonly archivedEndpoints?: readonly EntityRefKey[];
  readonly cardinalityOccupied?: boolean;
  readonly duplicatesPrimaryRelationship?: boolean;
  readonly axisMismatch?: boolean;
  readonly crossAxisConfirmed?: boolean;
}

export interface RelationshipLinkDecision {
  readonly status: 'create' | 'existing';
  readonly relationship: TypedRelationship;
}

const singleValuedKinds: readonly TypedRelationship['kind'][] = [
  'axis_outcome',
  'axis_project',
  'axis_routine',
  'axis_action',
  'axis_note',
  'outcome_milestone',
  'outcome_primary_project',
  'project_action',
  'project_note',
  'routine_defaults_project',
];

export const validateRelationshipLink = (
  input: ValidateRelationshipLinkInput,
): DomainResult<RelationshipLinkDecision> => {
  const kind = (input.relationship as { readonly kind?: unknown } | null)?.kind;
  if (typeof kind !== 'string' || !relationshipKinds.includes(kind as TypedRelationship['kind'])) {
    return err({
      code: 'unsupported_relationship',
      message: 'The relationship type is not allowed.',
    });
  }
  if (!endpointTypesAreValid(input.relationship)) {
    return err({
      code: 'unsupported_relationship',
      message: 'The relationship endpoint types are not allowed.',
    });
  }
  const [left, right] = relationshipEndpoints(input.relationship);
  if (left.ownerId !== right.ownerId) {
    return err({ code: 'owner_mismatch', message: 'Relationship endpoints must share an owner.' });
  }

  const key = relationshipKey(input.relationship);
  if (input.existingRelationshipKeys?.includes(key) === true) {
    return ok({ status: 'existing', relationship: input.relationship });
  }
  if (
    input.archivedEndpoints?.includes(entityRefKey(left)) === true ||
    input.archivedEndpoints?.includes(entityRefKey(right)) === true
  ) {
    return err({
      code: 'archived_endpoint',
      message: 'A new relationship cannot target an archived endpoint.',
    });
  }
  if (
    input.relationship.kind === 'outcome_secondary_project' &&
    input.duplicatesPrimaryRelationship === true
  ) {
    return err({
      code: 'cardinality_violation',
      message: 'A secondary Outcome cannot duplicate the Project primary Outcome.',
    });
  }
  if (
    (input.relationship.kind === 'project_action' ||
      input.relationship.kind === 'routine_defaults_project') &&
    input.axisMismatch === true &&
    input.crossAxisConfirmed !== true
  ) {
    return err({
      code: 'cross_axis_confirmation_required',
      message: 'Cross-Axis context requires explicit confirmation.',
    });
  }
  if (input.cardinalityOccupied === true && singleValuedKinds.includes(input.relationship.kind)) {
    return err({
      code: 'cardinality_violation',
      message: 'The relationship would exceed its allowed cardinality.',
    });
  }
  return ok({ status: 'create', relationship: input.relationship });
};

export const validateRelationshipUnlink = (
  relationship: TypedRelationship,
): DomainResult<{ readonly unlinkOnly: true }> =>
  relationship.kind === 'outcome_milestone'
    ? err({
        code: 'required_relationship',
        message: 'A Milestone must be reparented before removing its Outcome owner.',
      })
    : ok({ unlinkOnly: true });

export interface CreatePlanningPlacementInput {
  readonly ownerId: OwnerId;
  readonly target: PlacementTarget;
  readonly period: HorizonPeriod;
  readonly orderKey: string;
  readonly targetState?: ActionState;
  readonly existingPlacementId?: EntityId;
}

export interface PlanningPlacementDraft {
  readonly id: EntityId;
  readonly ownerId: OwnerId;
  readonly target: PlacementTarget;
  readonly period: HorizonPeriod;
  readonly orderKey: string;
}

export interface PlanningPlacementDecision {
  readonly placement: PlanningPlacementDraft;
  readonly replacesPlacementId?: EntityId;
  readonly targetStateAfterPlacement?: ActionState;
}

export const allowedPlacementKinds: Readonly<
  Record<PlacementTarget['type'], readonly HorizonPeriod['kind'][]>
> = {
  outcome: ['year', 'month'],
  project: ['year', 'month', 'week'],
  milestone: ['month', 'week'],
  action: ['month', 'week', 'day'],
};

export const validPeriod = (period: HorizonPeriod): boolean => {
  switch (period.kind) {
    case 'day':
      return parseCalendarDate(period.date).ok;
    case 'week': {
      const start = parseCalendarDate(period.start);
      const end = parseCalendarDate(period.end);
      if (!start.ok || !end.ok) return false;
      const canonical = createWeekPeriod(start.value, period.weekStart);
      return canonical.start === period.start && canonical.end === period.end;
    }
    case 'month':
      try {
        return Temporal.PlainYearMonth.from(period.month).toString() === period.month;
      } catch {
        return false;
      }
    case 'year':
      return /^\d{4}$/u.test(period.year);
  }
};

export const createPlanningPlacement = (
  input: CreatePlanningPlacementInput,
  ids: IdProvider,
): DomainResult<PlanningPlacementDecision> => {
  if (
    !(['outcome', 'project', 'milestone', 'action'] as const).includes(input.target.type) ||
    input.target.ownerId !== input.ownerId ||
    !validPeriod(input.period) ||
    input.orderKey.trim().length === 0
  ) {
    return err({ code: 'placement_not_allowed', message: 'The Planning Placement is invalid.' });
  }
  if (!allowedPlacementKinds[input.target.type].includes(input.period.kind)) {
    return err({
      code: 'placement_not_allowed',
      message: 'This entity cannot be placed at the selected Horizon.',
    });
  }

  const placement: PlanningPlacementDraft = {
    id: ids.next(),
    ownerId: input.ownerId,
    target: input.target,
    period: input.period,
    orderKey: input.orderKey,
  };
  const replacement =
    input.existingPlacementId === undefined
      ? {}
      : { replacesPlacementId: input.existingPlacementId };
  const actionState =
    input.target.type === 'action' && input.targetState === 'inbox'
      ? { targetStateAfterPlacement: 'planned' as const }
      : {};
  return ok({ placement, ...replacement, ...actionState });
};

export type FocusSelectionCandidate =
  | {
      readonly kind: 'day_focus';
      readonly ownerId: OwnerId;
      readonly target: EntityRef<'action' | 'routine_occurrence'>;
      readonly period: DayPeriod;
      readonly orderKey: string;
    }
  | {
      readonly kind: 'week_commitment';
      readonly ownerId: OwnerId;
      readonly target: EntityRef<'action' | 'project' | 'milestone'>;
      readonly period: WeekPeriod;
      readonly orderKey: string;
    };

export type ExistingFocusSelection = Omit<FocusSelectionCandidate, 'ownerId' | 'orderKey'>;
export type FocusWarning = 'small_set_recommended';

export interface FocusSelectionDecision {
  readonly warnings: readonly FocusWarning[];
  readonly status?: 'existing';
}

const periodKey = (period: DayPeriod | WeekPeriod): string =>
  period.kind === 'day'
    ? `day:${period.date}`
    : `week:${period.start}/${period.end}/${period.weekStart}`;

export const validateFocusSelection = (
  input: FocusSelectionCandidate,
  existing: readonly ExistingFocusSelection[],
  options: { readonly onboarding: boolean } = { onboarding: false },
): DomainResult<FocusSelectionDecision> => {
  const validKind =
    input.kind === 'day_focus'
      ? input.period.kind === 'day' &&
        (input.target.type === 'action' || input.target.type === 'routine_occurrence')
      : input.period.kind === 'week' &&
        (input.target.type === 'action' ||
          input.target.type === 'project' ||
          input.target.type === 'milestone');
  if (
    !validKind ||
    input.ownerId !== input.target.ownerId ||
    input.orderKey.trim().length === 0 ||
    !validPeriod(input.period)
  ) {
    return err({ code: 'invalid_value', message: 'The Focus Selection is invalid.' });
  }

  const inPeriod = existing.filter(
    (selection) =>
      selection.kind === input.kind && periodKey(selection.period) === periodKey(input.period),
  );
  if (inPeriod.some((selection) => entityRefKey(selection.target) === entityRefKey(input.target))) {
    return ok({ status: 'existing', warnings: [] });
  }
  if (input.kind === 'day_focus' && inPeriod.length >= 3) {
    return err({ code: 'selection_limit', message: 'Day focus is limited to three active items.' });
  }
  if (input.kind === 'week_commitment' && inPeriod.length >= 3) {
    return options.onboarding
      ? err({
          code: 'selection_limit',
          message: 'Onboarding Week commitments are limited to three active items.',
        })
      : ok({ warnings: ['small_set_recommended'] });
  }
  return ok({ warnings: [] });
};

export interface ArchivePreviewInput {
  readonly target: EntityRef;
  readonly directReminderIds: readonly EntityId[];
}

export interface ArchivePreview {
  readonly target: EntityRef;
  readonly archiveOnlyTarget: true;
  readonly cascadedTargets: readonly [];
  readonly reminderIdsRequiringExplicitDisable: readonly EntityId[];
  readonly undoable: true;
}

export const previewArchive = (input: ArchivePreviewInput): ArchivePreview => ({
  target: input.target,
  archiveOnlyTarget: true,
  cascadedTargets: [],
  reminderIdsRequiringExplicitDisable: input.directReminderIds,
  undoable: true,
});

export type RestoreBlocker = 'required_parent_missing' | 'period_invalid' | 'constraint_conflict';

export interface RestorePreviewInput {
  readonly requiredParentMissing: boolean;
  readonly periodInvalid: boolean;
  readonly constraintConflict: boolean;
}

export interface RestorePreview {
  readonly allowed: boolean;
  readonly blockers: readonly RestoreBlocker[];
}

export const previewRestore = (input: RestorePreviewInput): RestorePreview => {
  const blockers: RestoreBlocker[] = [];
  if (input.requiredParentMissing) blockers.push('required_parent_missing');
  if (input.periodInvalid) blockers.push('period_invalid');
  if (input.constraintConflict) blockers.push('constraint_conflict');
  return { allowed: blockers.length === 0, blockers };
};

export type PermanentDeletePolicy = 'restrict' | 'unlink_and_delete';
export type PermanentDeleteBlocker =
  | 'live_optional_relationships'
  | 'required_children'
  | 'placements'
  | 'selections'
  | 'reminders'
  | 'open_conflict'
  | 'pending_mutation'
  /**
   * History that still names the target and cannot be kept without it, such as Routine action
   * defaults (blocks under every policy). Review decisions never block: they are kept.
   */
  | 'history_references';

export interface PermanentDeleteImpact {
  readonly target: EntityRef;
  readonly optionalRelationshipCount: number;
  readonly requiredChildCount: number;
  readonly placementCount: number;
  readonly selectionCount: number;
  readonly reminderCount: number;
  readonly hasOpenConflict: boolean;
  readonly hasPendingMutation: boolean;
  /** The target's own history rows (such as unlinked links), removed with it and disclosed. */
  readonly historyReferenceCount: number;
  /**
   * History rows that keep their decision and lose only their reference to the target: review
   * items, which then show "Deleted object" and copy no title or body (placement contract,
   * permanent delete rule 6). Disclosed, and never a blocker under any policy.
   */
  readonly keptHistoryReferenceCount?: number;
  /**
   * History rows that still name the target and that the delete cannot keep without it: Routine
   * action defaults, part of a recurrence generation, and any review item the delete
   * cannot clear. They block deletion under every policy.
   */
  readonly blockingHistoryReferenceCount?: number;
}

export interface PermanentDeletePreview {
  readonly allowed: boolean;
  readonly blockers: readonly PermanentDeleteBlocker[];
  readonly deleteTargetOnly: true;
  readonly unlink: {
    readonly optionalRelationships: number;
    readonly placements: number;
    readonly selections: number;
    readonly reminders: number;
  };
  readonly historyReferenceCount: number;
  /** History rows kept with their reference to the target cleared ("Deleted object"). */
  readonly keptHistoryReferenceCount: number;
  readonly undoable: false;
}

export const previewPermanentDelete = (
  impact: PermanentDeleteImpact,
  policy: PermanentDeletePolicy = 'restrict',
): PermanentDeletePreview => {
  const blockers: PermanentDeleteBlocker[] = [];
  if (policy === 'restrict') {
    if (impact.optionalRelationshipCount > 0) blockers.push('live_optional_relationships');
    if (impact.placementCount > 0) blockers.push('placements');
    if (impact.selectionCount > 0) blockers.push('selections');
    if (impact.reminderCount > 0) blockers.push('reminders');
  }
  if (impact.requiredChildCount > 0) blockers.push('required_children');
  if ((impact.blockingHistoryReferenceCount ?? 0) > 0) blockers.push('history_references');
  if (impact.hasOpenConflict) blockers.push('open_conflict');
  if (impact.hasPendingMutation) blockers.push('pending_mutation');

  return {
    allowed: blockers.length === 0,
    blockers,
    deleteTargetOnly: true,
    unlink: {
      optionalRelationships: policy === 'unlink_and_delete' ? impact.optionalRelationshipCount : 0,
      placements: policy === 'unlink_and_delete' ? impact.placementCount : 0,
      selections: policy === 'unlink_and_delete' ? impact.selectionCount : 0,
      reminders: policy === 'unlink_and_delete' ? impact.reminderCount : 0,
    },
    historyReferenceCount: impact.historyReferenceCount,
    keptHistoryReferenceCount: impact.keptHistoryReferenceCount ?? 0,
    undoable: false,
  };
};

export interface DeletionTombstone {
  readonly ownerId: OwnerId;
  readonly entityType: EntityRef['type'];
  readonly entityId: EntityId;
  readonly revision: number;
  readonly deletedAt: Instant;
}

export const createDeletionTombstone = (
  target: EntityRef,
  revision: number,
  deletedAt: Instant,
): DeletionTombstone => ({
  ownerId: target.ownerId,
  entityType: target.type,
  entityId: target.id,
  revision,
  deletedAt,
});

/** Convenience for adapters that need a typed ref after validating persisted IDs. */
export const placementTargetRef = <Type extends PlacementTarget['type']>(
  type: Type,
  id: EntityId,
  ownerId: OwnerId,
): EntityRef<Type> => createEntityRef(type, id, ownerId);
