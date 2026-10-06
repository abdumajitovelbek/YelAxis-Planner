/**
 * planning manual scheduling facade: Time Blocks, Commitments, placements, Week commitments, capacity
 * constraints, Month themes, Year direction, and grouped undo. Every write is one
 * `executeCommand` transaction with owner-scoped refs, expected revisions, minimized audit events,
 * and a `planning.restore_v1` undo descriptor.
 */
import { err } from '@yelaxis/domain';

import { executeCommand } from './execute-command';
import type { PlanningQueryPort } from './planning-contracts';
import type { SchedulingMethods } from './planning';
import { planPlanningUndo, planningUndoCommandType } from './planning-kit';
import { createBlockCommands } from './planning-scheduling-blocks';
import { createHorizonCommands } from './planning-scheduling-horizons';
import { createSchedulingKit } from './planning-scheduling-support';
import type { ApplicationDependencies } from './ports';

export function createSchedulingCommands(
  dependencies: ApplicationDependencies,
  queries: PlanningQueryPort,
): SchedulingMethods {
  const kit = createSchedulingKit(dependencies, queries);
  return {
    ...createBlockCommands(kit),
    ...createHorizonCommands(kit),
    async undo(undoId, commandId) {
      const ownerId = await kit.ownerId();
      return executeCommand(
        dependencies,
        {
          commandId: commandId ?? dependencies.ids.next(),
          ownerId,
          actor: 'user',
          expectedRevisions: [],
          consumesUndoId: undoId,
          input: null,
        },
        ({ undoDescriptor, records, context }) => {
          if (undoDescriptor?.descriptor.commandType !== planningUndoCommandType)
            return err({
              code: 'invalid_value',
              message: 'This change cannot be undone here.',
              details: { reason: 'undo_unavailable' },
            });
          return planPlanningUndo(undoDescriptor.descriptor.payload, records, context);
        },
      );
    },
  };
}
