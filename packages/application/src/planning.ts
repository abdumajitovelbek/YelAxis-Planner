import type { PlanningApplication, PlanningQueryPort } from './planning-contracts';
import { createSerialQueue, serializeMethods, type SerialQueue } from './planning-kit';
import { createPlanningProjections } from './planning-projections';
import { createReminderMethods } from './planning-reminders';
import { createRoutineCommands } from './planning-routines';
import { createSchedulingCommands } from './planning-scheduling';
import { createTemplateCommands } from './planning-templates';
import { createPlanningZoneCommands } from './planning-zone';
import type { ApplicationDependencies } from './ports';
import { planningInputContracts } from './earlier-command-input';
import { guardInputMethods } from './runtime-input';

export type ProjectionMethods = Pick<
  PlanningApplication,
  | 'getDayPlan'
  | 'getWeekPlan'
  | 'getMonthPlan'
  | 'getYearPlan'
  | 'getMilestoneChain'
  | 'resolveLocalInterval'
  | 'listRoutines'
  | 'getRoutine'
  | 'previewRoutine'
  | 'listTemplates'
  | 'getTemplate'
  | 'previewTemplate'
  | 'getCapacitySettings'
  | 'listAxes'
  | 'listProjects'
>;

export type SchedulingMethods = Pick<
  PlanningApplication,
  | 'createCustomBlock'
  | 'scheduleAction'
  | 'moveBlock'
  | 'shortenBlock'
  | 'setBlockState'
  | 'keepOverlap'
  | 'createCommitment'
  | 'place'
  | 'unplace'
  | 'carryForward'
  | 'reorderPlacement'
  | 'addWeekCommitment'
  | 'removeWeekCommitment'
  | 'addAvailability'
  | 'editAvailability'
  | 'archiveConstraint'
  | 'setCapacityCap'
  | 'setMonthTheme'
  | 'clearMonthTheme'
  | 'setYearDirection'
  | 'clearYearDirection'
  | 'undo'
>;

export type RoutineMethods = Pick<
  PlanningApplication,
  | 'createRoutine'
  | 'repeatAfterAction'
  | 'editRoutineDetails'
  | 'editRoutineThisAndFuture'
  | 'pauseRoutine'
  | 'resumeRoutine'
  | 'archiveRoutine'
  | 'restoreRoutine'
  | 'completeOccurrence'
  | 'skipOccurrence'
  | 'reopenOccurrence'
  | 'editOccurrence'
>;

export type TemplateMethods = Pick<
  PlanningApplication,
  | 'applyTemplate'
  | 'duplicateTemplate'
  | 'saveTemplate'
  | 'archiveTemplate'
  | 'restoreTemplate'
  | 'saveWeekAsTemplate'
>;

/** Review reminder definitions; `getRoutine` adds the Routine's reminder. */
export type ReminderMethods = Pick<
  PlanningApplication,
  | 'getRoutine'
  | 'getTimeBlockReminder'
  | 'setTimeBlockReminder'
  | 'turnOffTimeBlockReminder'
  | 'setRoutineReminder'
  | 'turnOffRoutineReminder'
>;

/**
 * planning manual planning facade. Every call is serialized because the browser owns one SQLite worker
 * connection; each command keeps its own application-owned transaction.
 */
export function createPlanningApplication(
  dependencies: ApplicationDependencies,
  queries: PlanningQueryPort,
  options: { readonly queue?: SerialQueue } = {},
): PlanningApplication {
  const projections = createPlanningProjections(dependencies, queries);
  const application: PlanningApplication = {
    ...projections,
    ...createSchedulingCommands(dependencies, queries),
    ...createRoutineCommands(dependencies, queries),
    ...createTemplateCommands(dependencies, queries),
    ...createPlanningZoneCommands(dependencies, queries),
    // Last, so the Routine detail it returns includes the Routine's reminder.
    ...createReminderMethods(dependencies, queries, projections),
  };
  return serializeMethods(
    guardInputMethods(application, planningInputContracts),
    options.queue ?? createSerialQueue(),
  );
}
