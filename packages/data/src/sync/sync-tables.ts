/**
 * Where each synced entity type lives. Sync metadata (`server_revision`, `base_snapshot_hash`) is
 * written on the record's own row; Focus Selections live in two tables (day focus and Week
 * commitments), and a Routine's generation rows belong to the Routine document.
 */
import type { EntityType } from '@yelaxis/domain';

export interface SyncTable {
  readonly table: string;
  /** Join rows keep `deleted_at` as their unlinked state, so it never hides them. */
  readonly anyState?: true;
}

export const syncEntityTables: Readonly<Record<EntityType, readonly SyncTable[]>> = {
  profile: [{ table: 'profiles' }],
  axis: [{ table: 'axes' }],
  outcome: [{ table: 'outcomes' }],
  milestone: [{ table: 'milestones' }],
  project: [{ table: 'projects' }],
  action: [{ table: 'actions' }],
  note: [{ table: 'notes' }],
  commitment: [{ table: 'commitments' }],
  time_block: [{ table: 'time_blocks' }],
  routine: [{ table: 'routines' }],
  routine_occurrence: [{ table: 'routine_occurrences' }],
  routine_action_defaults: [{ table: 'routine_action_defaults' }],
  template: [{ table: 'templates' }],
  review: [{ table: 'review_checkpoints' }],
  review_item: [{ table: 'review_items' }],
  reminder: [{ table: 'reminders' }],
  context: [{ table: 'contexts' }],
  constraint: [{ table: 'constraints' }],
  planning_placement: [{ table: 'planning_placements' }],
  focus_selection: [{ table: 'focus_selections' }, { table: 'week_selections' }],
  theme: [{ table: 'month_themes' }],
  direction: [{ table: 'year_directions' }],
  project_secondary_outcome: [{ table: 'project_secondary_outcomes', anyState: true }],
  milestone_project: [{ table: 'milestone_projects', anyState: true }],
  milestone_action: [{ table: 'milestone_actions', anyState: true }],
};

/** Tables a reference check covers for an entity type (a Routine includes its generations). */
export function referenceTablesOf(entityType: EntityType): readonly string[] {
  const tables = syncEntityTables[entityType].map((item) => item.table);
  return entityType === 'routine' ? [...tables, 'routine_generations'] : tables;
}

const entityByTable = new Map<string, EntityType>(
  (Object.entries(syncEntityTables) as [EntityType, readonly SyncTable[]][]).flatMap(
    ([entityType, tables]) => tables.map((item) => [item.table, entityType] as const),
  ),
);

/** The entity type a table's rows are, when they are synced records. */
export function entityOfTable(table: string): EntityType | undefined {
  return entityByTable.get(table);
}

/** Every synced record table once (first-upload progress). */
export const syncRecordTables: readonly SyncTable[] = Object.values(syncEntityTables).flat();
