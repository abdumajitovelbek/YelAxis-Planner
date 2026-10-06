import type { EntityType } from '@yelaxis/domain';

import type { CountsByKind } from '../account/account-service';

/** Display labels of record kinds, in the order previews list them. */
const kindLabels: readonly (readonly [EntityType, string])[] = [
  ['axis', 'Axes'],
  ['outcome', 'Outcomes'],
  ['milestone', 'Milestones'],
  ['project', 'Projects'],
  ['action', 'Actions'],
  ['note', 'Notes'],
  ['routine', 'Routines'],
  ['routine_occurrence', 'Routine days'],
  ['routine_action_defaults', 'Routine Action details'],
  ['time_block', 'Time Blocks'],
  ['commitment', 'Commitments'],
  ['planning_placement', 'Plan placements'],
  ['focus_selection', 'Focus and week choices'],
  ['theme', 'Month themes'],
  ['direction', 'Year directions'],
  ['review', 'Reviews'],
  ['review_item', 'Review decisions'],
  ['reminder', 'Reminders'],
  ['template', 'Templates'],
  ['context', 'Context entries'],
  ['constraint', 'Availability and limits'],
  ['project_secondary_outcome', 'Outcome links'],
  ['milestone_project', 'Milestone Project links'],
  ['milestone_action', 'Milestone Action links'],
  ['profile', 'Planning profile'],
];

type MissingKind = Exclude<EntityType, (typeof kindLabels)[number][0]>;
const kindParity: [MissingKind] extends [never] ? true : never = true;
void kindParity;

/** Counts by kind for display: every kind with records, in display order. */
export function countsByKind(byType: Readonly<Partial<Record<string, number>>>): CountsByKind {
  const kinds = kindLabels.flatMap(([type, label]) => {
    const count = byType[type] ?? 0;
    return count > 0 ? [{ label, count }] : [];
  });
  return { kinds, total: kinds.reduce((sum, { count }) => sum + count, 0) };
}
