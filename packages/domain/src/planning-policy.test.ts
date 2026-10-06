import { describe, expect, it } from 'vitest';

import {
  createDayPeriod,
  createEntityRef,
  createMonthPeriod,
  createPlanningPlacement,
  createWeekPeriod,
  createYearPeriod,
  entityRefKey,
  parseCalendarDate,
  parseInstant,
  parseUUID,
  previewArchive,
  previewPermanentDelete,
  previewRestore,
  relationshipKey,
  validateFocusSelection,
  validateRelationshipLink,
  validateRelationshipUnlink,
  type CalendarDate,
  type DomainResult,
  type EntityRef,
  type EntityType,
  type IdProvider,
  type FocusSelectionCandidate,
  type TypedRelationship,
} from './index.js';

const expectValue = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
const uuid = (suffix: string) =>
  expectValue(parseUUID(`0190c2b1-7d9a-7cc1-8be5-b88620c57f5${suffix}`));
const ownerId = uuid('0');
const otherOwnerId = uuid('1');
const date = (value: string): CalendarDate => expectValue(parseCalendarDate(value));
const ref = <Type extends EntityType>(
  type: Type,
  suffix: string,
  owner = ownerId,
): EntityRef<Type> => createEntityRef(type, uuid(suffix), owner);

const axis = ref('axis', '2');
const outcome = ref('outcome', '3');
const milestone = ref('milestone', '4');
const project = ref('project', '5');
const action = ref('action', '6');
const routine = ref('routine', '7');
const occurrence = ref('routine_occurrence', '8');
const defaults = ref('routine_action_defaults', '9');
const note = ref('note', 'a');

describe('typed relationships', () => {
  it('accepts every approved typed relationship shape and derives stable keys', () => {
    const relationships: readonly TypedRelationship[] = [
      { kind: 'axis_outcome', axis, outcome },
      { kind: 'axis_project', axis, project },
      { kind: 'axis_routine', axis, routine },
      { kind: 'axis_action', axis, action },
      { kind: 'axis_note', axis, note },
      { kind: 'outcome_milestone', outcome, milestone },
      { kind: 'outcome_primary_project', outcome, project },
      { kind: 'outcome_secondary_project', outcome, project },
      { kind: 'project_action', project, action },
      { kind: 'project_note', project, note },
      { kind: 'routine_defaults_project', defaults, project },
      { kind: 'milestone_project', milestone, project },
      { kind: 'milestone_action', milestone, action },
    ];
    for (const relationship of relationships) {
      expect(validateRelationshipLink({ relationship }).ok).toBe(true);
    }
    expect(new Set(relationships.map(relationshipKey)).size).toBe(relationships.length);
    expect(relationshipKey(relationships[3]!)).toBe(
      `${entityRefKey(axis)}:axis_action:${entityRefKey(action)}`,
    );
  });

  it('rejects cross-owner and archived endpoints', () => {
    expect(
      validateRelationshipLink({
        relationship: {
          kind: 'project_action',
          project,
          action: ref('action', 'a', otherOwnerId),
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'owner_mismatch' } });
    expect(
      validateRelationshipLink({
        relationship: { kind: 'outcome_milestone', outcome, milestone },
        archivedEndpoints: [entityRefKey(outcome)],
      }),
    ).toMatchObject({ ok: false, error: { code: 'archived_endpoint' } });
  });

  it('fails closed on an arbitrary graph edge at runtime', () => {
    expect(
      validateRelationshipLink({
        relationship: {
          kind: 'arbitrary_edge',
          from: action,
          to: outcome,
        } as unknown as TypedRelationship,
      }),
    ).toMatchObject({ ok: false, error: { code: 'unsupported_relationship' } });
  });

  it('makes duplicate links idempotent before cardinality validation', () => {
    const relationship: TypedRelationship = { kind: 'project_action', project, action };
    expect(
      validateRelationshipLink({
        relationship,
        existingRelationshipKeys: [relationshipKey(relationship)],
        cardinalityOccupied: true,
      }),
    ).toEqual({ ok: true, value: { status: 'existing', relationship } });
    expect(validateRelationshipLink({ relationship, cardinalityOccupied: true })).toMatchObject({
      ok: false,
      error: { code: 'cardinality_violation' },
    });
  });

  it('requires visible confirmation for Action/Project and Routine-default cross-Axis context', () => {
    expect(
      validateRelationshipLink({
        relationship: { kind: 'project_action', project, action },
        axisMismatch: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'cross_axis_confirmation_required' },
    });
    expect(
      validateRelationshipLink({
        relationship: { kind: 'routine_defaults_project', defaults, project },
        axisMismatch: true,
        crossAxisConfirmed: true,
      }).ok,
    ).toBe(true);
  });

  it('does not allow a secondary Outcome link to duplicate the primary link', () => {
    expect(
      validateRelationshipLink({
        relationship: { kind: 'outcome_secondary_project', outcome, project },
        duplicatesPrimaryRelationship: true,
      }),
    ).toMatchObject({ ok: false, error: { code: 'cardinality_violation' } });
  });

  it('blocks unlinking the required Outcome owner of a Milestone but never deletes endpoints', () => {
    expect(
      validateRelationshipUnlink({ kind: 'outcome_milestone', outcome, milestone }),
    ).toMatchObject({ ok: false, error: { code: 'required_relationship' } });
    expect(validateRelationshipUnlink({ kind: 'project_action', project, action })).toEqual({
      ok: true,
      value: { unlinkOnly: true },
    });
  });
});

describe('planning placements and focus selections', () => {
  const ids: IdProvider = { next: () => uuid('b') };

  it('enforces the direct placement matrix and injects placement IDs', () => {
    const day = createDayPeriod(date('2026-07-23'));
    expect(
      createPlanningPlacement(
        { ownerId, target: action, period: day, orderKey: 'a0', targetState: 'inbox' },
        ids,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        placement: { id: uuid('b'), target: action, period: day },
        targetStateAfterPlacement: 'planned',
      },
    });
    expect(
      createPlanningPlacement({ ownerId, target: outcome, period: day, orderKey: 'a0' }, ids),
    ).toMatchObject({ ok: false, error: { code: 'placement_not_allowed' } });
    expect(
      createPlanningPlacement(
        {
          ownerId,
          target: routine as unknown as EntityRef<'action'>,
          period: createMonthPeriod(date('2026-07-01')),
          orderKey: 'a0',
        },
        ids,
      ).ok,
    ).toBe(false);
    expect(
      createPlanningPlacement(
        {
          ownerId,
          target: project,
          period: createYearPeriod(date('2026-01-01')),
          orderKey: 'a0',
          existingPlacementId: uuid('c'),
        },
        ids,
      ),
    ).toMatchObject({ ok: true, value: { replacesPlacementId: uuid('c') } });
  });

  it('caps unique Day focus at three without changing target state or priority', () => {
    const day = createDayPeriod(date('2026-07-23'));
    const existing = [
      { kind: 'day_focus' as const, target: ref('action', 'c'), period: day },
      { kind: 'day_focus' as const, target: ref('action', 'd'), period: day },
      { kind: 'day_focus' as const, target: occurrence, period: day },
    ];
    expect(
      validateFocusSelection(
        { kind: 'day_focus', ownerId, target: action, period: day, orderKey: 'a0' },
        existing,
      ),
    ).toMatchObject({ ok: false, error: { code: 'selection_limit' } });
    expect(
      validateFocusSelection(
        { kind: 'day_focus', ownerId, target: action, period: day, orderKey: 'a0' },
        [existing[0]!],
      ),
    ).toEqual({ ok: true, value: { warnings: [] } });
  });

  it('makes duplicate Focus selection idempotent and rejects kind-period mismatches', () => {
    const day = createDayPeriod(date('2026-07-23'));
    const input = {
      kind: 'day_focus' as const,
      ownerId,
      target: action,
      period: day,
      orderKey: 'a0',
    };
    expect(
      validateFocusSelection(input, [{ kind: 'day_focus', target: action, period: day }]),
    ).toEqual({ ok: true, value: { status: 'existing', warnings: [] } });

    const mismatched = {
      ...input,
      period: createWeekPeriod(date('2026-07-23'), 'monday'),
    } as unknown as FocusSelectionCandidate;
    expect(validateFocusSelection(mismatched, []).ok).toBe(false);
  });

  it('hard-caps onboarding Week commitments, then returns only a small-set warning', () => {
    const week = createWeekPeriod(date('2026-07-23'), 'monday');
    const existing = [
      { kind: 'week_commitment' as const, target: action, period: week },
      { kind: 'week_commitment' as const, target: project, period: week },
      { kind: 'week_commitment' as const, target: milestone, period: week },
    ];
    const input = {
      kind: 'week_commitment' as const,
      ownerId,
      target: ref('action', 'e'),
      period: week,
      orderKey: 'a0',
    };
    expect(validateFocusSelection(input, existing, { onboarding: true }).ok).toBe(false);
    expect(validateFocusSelection(input, existing, { onboarding: false })).toEqual({
      ok: true,
      value: { warnings: ['small_set_recommended'] },
    });
  });
});

describe('archive, restore, and permanent-delete previews', () => {
  it('archives only the selected object and requires explicit reminder handling', () => {
    expect(previewArchive({ target: action, directReminderIds: [uuid('f')] })).toEqual({
      target: action,
      archiveOnlyTarget: true,
      cascadedTargets: [],
      reminderIdsRequiringExplicitDisable: [uuid('f')],
      undoable: true,
    });
  });

  it('blocks restore until required parents and current constraints are valid', () => {
    expect(
      previewRestore({
        requiredParentMissing: true,
        periodInvalid: false,
        constraintConflict: false,
      }),
    ).toEqual({ allowed: false, blockers: ['required_parent_missing'] });
    expect(
      previewRestore({
        requiredParentMissing: false,
        periodInvalid: false,
        constraintConflict: false,
      }),
    ).toEqual({ allowed: true, blockers: [] });
  });

  it('defaults delete to restrict and never recursively deletes another domain object', () => {
    const impact = {
      target: action,
      optionalRelationshipCount: 2,
      requiredChildCount: 0,
      placementCount: 1,
      selectionCount: 1,
      reminderCount: 1,
      hasOpenConflict: false,
      hasPendingMutation: false,
      historyReferenceCount: 3,
    } as const;
    expect(previewPermanentDelete(impact, 'restrict')).toMatchObject({
      allowed: false,
      undoable: false,
      deleteTargetOnly: true,
    });
    expect(previewPermanentDelete(impact, 'unlink_and_delete')).toEqual({
      allowed: true,
      blockers: [],
      deleteTargetOnly: true,
      unlink: {
        optionalRelationships: 2,
        placements: 1,
        selections: 1,
        reminders: 1,
      },
      historyReferenceCount: 3,
      keptHistoryReferenceCount: 0,
      undoable: false,
    });
  });

  it('never lets unlink-and-delete bypass required children, conflicts, or pending sync', () => {
    expect(
      previewPermanentDelete(
        {
          target: outcome,
          optionalRelationshipCount: 0,
          requiredChildCount: 1,
          placementCount: 0,
          selectionCount: 0,
          reminderCount: 0,
          hasOpenConflict: true,
          hasPendingMutation: true,
          historyReferenceCount: 0,
        },
        'unlink_and_delete',
      ),
    ).toMatchObject({
      allowed: false,
      blockers: ['required_children', 'open_conflict', 'pending_mutation'],
      deleteTargetOnly: true,
    });
  });

  it('keeps review decisions: they are disclosed and never block under any policy (rule 6)', () => {
    const impact = {
      target: action,
      optionalRelationshipCount: 0,
      requiredChildCount: 0,
      placementCount: 0,
      selectionCount: 0,
      reminderCount: 0,
      hasOpenConflict: false,
      hasPendingMutation: false,
      historyReferenceCount: 1,
      keptHistoryReferenceCount: 3,
    } as const;
    for (const policy of ['restrict', 'unlink_and_delete'] as const) {
      expect(previewPermanentDelete(impact, policy)).toEqual({
        allowed: true,
        blockers: [],
        deleteTargetOnly: true,
        unlink: { optionalRelationships: 0, placements: 0, selections: 0, reminders: 0 },
        historyReferenceCount: 1,
        keptHistoryReferenceCount: 3,
        undoable: false,
      });
    }
    // Kept decisions never lift a real blocker either.
    expect(
      previewPermanentDelete({ ...impact, placementCount: 1, blockingHistoryReferenceCount: 1 }),
    ).toMatchObject({
      allowed: false,
      blockers: ['placements', 'history_references'],
      keptHistoryReferenceCount: 3,
    });
    const { keptHistoryReferenceCount: _omitted, ...withoutField } = impact;
    expect(_omitted).toBe(3);
    expect(previewPermanentDelete(withoutField).keptHistoryReferenceCount).toBe(0);
  });

  it('blocks deletion under every policy while Routine defaults reference it', () => {
    const impact = {
      target: project,
      optionalRelationshipCount: 1,
      requiredChildCount: 0,
      placementCount: 0,
      selectionCount: 0,
      reminderCount: 0,
      hasOpenConflict: false,
      hasPendingMutation: false,
      historyReferenceCount: 4,
      blockingHistoryReferenceCount: 2,
    } as const;
    expect(previewPermanentDelete(impact, 'restrict')).toMatchObject({
      allowed: false,
      blockers: ['live_optional_relationships', 'history_references'],
    });
    expect(previewPermanentDelete(impact, 'unlink_and_delete')).toMatchObject({
      allowed: false,
      blockers: ['history_references'],
      unlink: { optionalRelationships: 1 },
      historyReferenceCount: 4,
      undoable: false,
    });
    const cleared = { ...impact, blockingHistoryReferenceCount: 0 };
    expect(previewPermanentDelete(cleared, 'unlink_and_delete')).toMatchObject({
      allowed: true,
      blockers: [],
    });
    const { blockingHistoryReferenceCount: _omitted, ...withoutField } = impact;
    expect(_omitted).toBe(2);
    expect(previewPermanentDelete(withoutField, 'unlink_and_delete').blockers).toEqual([]);
  });

  it('builds a minimal tombstone without copying user content', async () => {
    const { createDeletionTombstone } = await import('./index.js');
    const tombstone = createDeletionTombstone(
      action,
      8,
      expectValue(parseInstant('2026-07-23T11:00:00Z')),
    );
    expect(tombstone).toEqual({
      ownerId,
      entityType: 'action',
      entityId: action.id,
      revision: 8,
      deletedAt: '2026-07-23T11:00:00.000Z',
    });
    expect(tombstone).not.toHaveProperty('title');
    expect(tombstone).not.toHaveProperty('body');
  });
});
