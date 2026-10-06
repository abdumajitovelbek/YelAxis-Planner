/**
 * The record codec schemas that `@yelaxis/data` exports, by entity type, so the backend tests can
 * show that a document the server accepts is one every replica accepts, and that a document it
 * refuses is one every replica refuses. Profile and Context documents have no exported schema.
 */
import {
  actionCanonicalDocumentSchema,
  axisDocumentSchema,
  commitmentDocumentSchema,
  constraintDocumentSchema,
  focusSelectionDocumentSchema,
  milestoneActionDocumentSchema,
  milestoneDocumentSchema,
  milestoneProjectDocumentSchema,
  monthThemeDocumentSchema,
  noteDocumentSchema,
  outcomeDocumentSchema,
  planningPlacementDocumentSchema,
  projectDocumentSchema,
  projectSecondaryOutcomeDocumentSchema,
  reminderDocumentSchema,
  reviewDocumentSchema,
  reviewItemDocumentSchema,
  routineActionDefaultsDocumentSchema,
  routineDocumentSchema,
  routineOccurrenceDocumentSchema,
  templateDocumentSchema,
  timeBlockDocumentSchema,
  yearDirectionDocumentSchema,
} from '@yelaxis/data';
import type { z } from 'zod';

import type { SyncEntityType } from '../protocol';

export const recordCodecSchemas: Readonly<Partial<Record<SyncEntityType, z.ZodType>>> = {
  axis: axisDocumentSchema,
  outcome: outcomeDocumentSchema,
  milestone: milestoneDocumentSchema,
  project: projectDocumentSchema,
  action: actionCanonicalDocumentSchema,
  note: noteDocumentSchema,
  commitment: commitmentDocumentSchema,
  time_block: timeBlockDocumentSchema,
  routine: routineDocumentSchema,
  routine_occurrence: routineOccurrenceDocumentSchema,
  routine_action_defaults: routineActionDefaultsDocumentSchema,
  template: templateDocumentSchema,
  review: reviewDocumentSchema,
  review_item: reviewItemDocumentSchema,
  reminder: reminderDocumentSchema,
  constraint: constraintDocumentSchema,
  planning_placement: planningPlacementDocumentSchema,
  focus_selection: focusSelectionDocumentSchema,
  theme: monthThemeDocumentSchema,
  direction: yearDirectionDocumentSchema,
  project_secondary_outcome: projectSecondaryOutcomeDocumentSchema,
  milestone_project: milestoneProjectDocumentSchema,
  milestone_action: milestoneActionDocumentSchema,
};

/** Whether the record codec of `entityType` accepts `document`; undefined without a schema. */
export function codecAccepts(entityType: SyncEntityType, document: unknown): boolean | undefined {
  return recordCodecSchemas[entityType]?.safeParse(document).success;
}
