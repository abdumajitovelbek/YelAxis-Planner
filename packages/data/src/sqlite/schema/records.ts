export type PlanningPlacementTarget =
  | Readonly<{ kind: 'outcome'; outcomeId: string }>
  | Readonly<{ kind: 'project'; projectId: string }>
  | Readonly<{ kind: 'milestone'; milestoneId: string }>
  | Readonly<{ kind: 'action'; actionId: string }>;

export type TimeBlockTarget =
  | Readonly<{ kind: 'action'; actionId: string }>
  | Readonly<{ kind: 'routine_occurrence'; routineOccurrenceId: string }>
  | Readonly<{ kind: 'commitment'; commitmentId: string }>
  | Readonly<{ kind: 'custom'; title: string }>;

export type TypedPlanningRelationship =
  | Readonly<{
      kind: 'project_secondary_outcome';
      projectId: string;
      outcomeId: string;
    }>
  | Readonly<{
      kind: 'milestone_project';
      milestoneId: string;
      projectId: string;
    }>
  | Readonly<{
      kind: 'milestone_action';
      milestoneId: string;
      actionId: string;
    }>;

export type TimeBlockTargetColumns = Readonly<{
  action_id: string | null;
  routine_occurrence_id: string | null;
  commitment_id: string | null;
  custom_title: string | null;
}>;

export function decodeTimeBlockTarget(columns: TimeBlockTargetColumns): TimeBlockTarget {
  if (columns.action_id !== null) return { kind: 'action', actionId: columns.action_id };
  if (columns.routine_occurrence_id !== null) {
    return { kind: 'routine_occurrence', routineOccurrenceId: columns.routine_occurrence_id };
  }
  if (columns.commitment_id !== null) {
    return { kind: 'commitment', commitmentId: columns.commitment_id };
  }
  if (columns.custom_title !== null) return { kind: 'custom', title: columns.custom_title };
  throw new Error('Time Block row did not contain its checked target union');
}
