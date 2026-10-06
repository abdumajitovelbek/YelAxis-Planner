/** Runtime contracts for legacy manual commands; existing domain validators own semantic rules. */
import {
  parseCalendarDate,
  parseIanaTimeZone,
  parseMonthKey,
  parseYearKey,
  parseUUID,
  weekdays,
} from '@yelaxis/domain';

import type { ActionApplication } from './actions';
import type { AlignmentApplication, AlignmentProjectionMethods } from './alignment-contracts';
import type { PlanningApplication } from './planning-contracts';
import type { ProjectionMethods, ReminderMethods } from './planning';
import type { TodayApplication } from './today-contracts';
import {
  inputBoolean as boolean,
  inputInteger as integer,
  inputString as string,
  inputRevision as revision,
  inputChoice as choice,
  inputList as list,
  inputObject as object,
  inputUnion as union,
  optionalInput as optional,
  nullableInput as nullable,
  type InputCheck,
  isInputRecord,
} from './runtime-input';

const uuid: InputCheck = (value) => typeof value === 'string' && parseUUID(value).ok;
const date: InputCheck = (value) => typeof value === 'string' && parseCalendarDate(value).ok;
const zone: InputCheck = (value) => typeof value === 'string' && parseIanaTimeZone(value).ok;
const month: InputCheck = (value) => typeof value === 'string' && parseMonthKey(value).ok;
const year: InputCheck = (value) => typeof value === 'string' && parseYearKey(value).ok;
const optionalId = optional(union(uuid, choice('')));
const optionalDate = optional(union(date, choice('')));
const commandId = optional(uuid);
const direction = choice('up', 'down');
const idRevision = { id: uuid, revision };
const schedule = object({ date, startTime: string, endTime: string });
const reminder = object({
  enabled: boolean,
  kind: choice('at', 'relative'),
  date: optionalDate,
  time: optional(string),
  offsetMinutes: optional(integer),
});
const actionFields = {
  title: string,
  note: optional(string),
  estimateMinutes: optional(integer),
  energy: optional(string),
  priority: optional(string),
};
const actionForm = object({
  ...actionFields,
  axisId: optionalId,
  projectId: optionalId,
  plannedDate: optionalDate,
  dueDate: optionalDate,
  dueTime: optional(string),
  schedule: optional(schedule),
  reminder: optional(reminder),
  confirmCrossAxis: optional(boolean),
});
const actionPeriod = object({ kind: choice('day', 'week', 'month'), date });
const doChoice = object({ kind: choice('do'), date: optionalDate, schedule: optional(schedule) });
const planChoice = object({
  kind: choice('plan'),
  period: actionPeriod,
  projectId: optionalId,
  milestoneId: optional(string),
  confirmCrossAxis: optional(boolean),
});
const triage = union(
  doChoice,
  planChoice,
  object({ kind: choice('keep_note', 'keep_project', 'cancel', 'archive', 'complete') }),
);
const bulk = union(
  object({ kind: choice('do'), date: optionalDate }),
  object({ kind: choice('plan'), period: actionPeriod }),
  object({ kind: choice('axis'), axisId: optionalId, confirmCrossAxis: optional(boolean) }),
  object({ kind: choice('project'), projectId: optionalId, confirmCrossAxis: optional(boolean) }),
  object({ kind: choice('complete', 'cancel', 'archive') }),
);

export const actionInputContracts = {
  capture: [
    object({
      commandId: uuid,
      actionId: uuid,
      origin: choice(
        'global_capture',
        'onboarding',
        'today',
        'plan',
        'axis',
        'review',
        'inbox',
        'project',
        'import',
        'other',
      ),
    }),
    actionForm,
  ],
  edit: [uuid, revision, actionForm, commandId],
  triage: [uuid, revision, triage, commandId],
  transition: [
    uuid,
    revision,
    choice('inbox', 'planned', 'scheduled', 'in_progress', 'completed', 'canceled', 'archived'),
    commandId,
  ],
  reorder: [uuid, revision, direction, commandId],
  bulk: [list(object(idRevision)), bulk, commandId],
  undo: [uuid, commandId],
  deletePermanently: [uuid, revision, string, commandId],
} satisfies Record<
  Exclude<
    keyof ActionApplication,
    | 'newCaptureIntent'
    | 'listInbox'
    | 'listAllInbox'
    | 'getAction'
    | 'listAxes'
    | 'listProjects'
    | 'listMilestones'
  >,
  readonly InputCheck[]
>;

const period = object({ kind: choice('day', 'week', 'month', 'year'), date });
const occurrencePeriod = union(
  object({ kind: choice('date'), date }),
  object({
    kind: choice('week'),
    start: date,
    end: date,
    weekStart: choice(...weekdays),
    targetCount: revision,
  }),
);
const occurrence = object({
  routineId: uuid,
  generation: revision,
  period: occurrencePeriod,
  revision: optional(revision),
});
const timed = union(
  object({ kind: choice('block'), blockId: uuid, revision }),
  object({ kind: choice('occurrence'), occurrence }),
);
const interval = { date, startTime: string, durationMinutes: integer };
const defaults = object({
  projectId: optionalId,
  note: optional(string),
  estimateMinutes: optional(integer),
  energy: optional(string),
  priority: optional(string),
});
const raw: InputCheck = () => true; // Versioned recurrence/mode/blueprint parsers are called by the command.
const routine = {
  title: string,
  description: optional(string),
  axisId: optionalId,
  rule: raw,
  schedulingMode: raw,
  defaults: optional(defaults),
  // Review's strict versioned reminder parser keeps its specific error contract.
  reminder: optional(raw),
};
const routineIdentity = { routineId: uuid, revision };
const templateIdentity = { templateId: uuid, revision };
const availability = {
  strength: choice('hard', 'soft', 'unknown'),
  windows: list(object({ weekday: choice(...weekdays), start: string, end: string })),
};
const target = object({ kind: choice('action', 'project', 'milestone', 'outcome'), ...idRevision });

export const planningInputContracts = {
  createCustomBlock: [
    object({ ...interval, title: string, overlapAcknowledged: boolean }),
    commandId,
  ],
  scheduleAction: [
    object({ ...interval, actionId: uuid, revision, overlapAcknowledged: boolean }),
    commandId,
  ],
  moveBlock: [
    object({ ...interval, blockId: uuid, revision, overlapAcknowledged: boolean }),
    commandId,
  ],
  shortenBlock: [object({ blockId: uuid, revision, durationMinutes: integer }), commandId],
  setBlockState: [
    object({
      blockId: uuid,
      revision,
      to: choice('planned', 'completed', 'skipped', 'canceled'),
      alsoCompleteAction: optional(boolean),
    }),
    commandId,
  ],
  keepOverlap: [object({ first: timed, second: timed }), commandId],
  createCommitment: [
    object({
      ...interval,
      title: string,
      strength: choice('hard', 'soft'),
      overlapAcknowledged: boolean,
    }),
    commandId,
  ],
  place: [object({ target, period }), commandId],
  unplace: [object({ target }), commandId],
  carryForward: [object({ actions: list(object(idRevision)), period }), commandId],
  reorderPlacement: [object({ placementId: uuid, revision, direction, scope: period }), commandId],
  addWeekCommitment: [
    object({
      weekDate: date,
      target: object({ kind: choice('action', 'project', 'milestone'), id: uuid }),
    }),
    commandId,
  ],
  removeWeekCommitment: [object({ selectionId: uuid, revision }), commandId],
  createRoutine: [object(routine), commandId],
  repeatAfterAction: [object({ ...routine, actionId: uuid }), commandId],
  editRoutineDetails: [
    object({
      ...routineIdentity,
      title: string,
      description: optional(string),
      axisId: optionalId,
    }),
    commandId,
  ],
  editRoutineThisAndFuture: [
    object({
      ...routineIdentity,
      selectedOn: date,
      rule: raw,
      schedulingMode: raw,
      defaults: optional(defaults),
    }),
    commandId,
  ],
  pauseRoutine: [object({ ...routineIdentity, pauseOn: date }), commandId],
  resumeRoutine: [object({ ...routineIdentity, resumeOn: date }), commandId],
  archiveRoutine: [object(routineIdentity), commandId],
  restoreRoutine: [object(routineIdentity), commandId],
  completeOccurrence: [object({ occurrence, confirmExtra: optional(boolean) }), commandId],
  skipOccurrence: [object({ occurrence }), commandId],
  reopenOccurrence: [object({ occurrence }), commandId],
  editOccurrence: [
    object({
      occurrence,
      date,
      startTime: optional(string),
      durationMinutes: optional(integer),
      overlapAcknowledged: boolean,
    }),
    commandId,
  ],
  applyTemplate: [
    object({
      templateId: uuid,
      anchorDate: date,
      timeZone: zone,
      selectedKeys: list(string),
      overlapAcknowledged: boolean,
    }),
    commandId,
  ],
  duplicateTemplate: [object({ templateId: uuid, title: string }), commandId],
  saveTemplate: [
    object({
      templateId: optional(uuid),
      revision: optional(revision),
      title: string,
      blueprint: raw,
    }),
    commandId,
  ],
  archiveTemplate: [object(templateIdentity), commandId],
  restoreTemplate: [object(templateIdentity), commandId],
  saveWeekAsTemplate: [object({ weekDate: date, title: string }), commandId],
  addAvailability: [object(availability), commandId],
  editAvailability: [object({ ...availability, constraintId: uuid, revision }), commandId],
  archiveConstraint: [object({ constraintId: uuid, revision }), commandId],
  setCapacityCap: [
    object({ period: choice('day', 'week'), minutes: nullable(integer) }),
    commandId,
  ],
  setMonthTheme: [object({ month, text: string }), commandId],
  clearMonthTheme: [object({ month }), commandId],
  setYearDirection: [object({ year, text: string }), commandId],
  clearYearDirection: [object({ year }), commandId],
  changePlanningZone: [object({ zone, revision }), commandId],
  // Review reminder commands already validate their entire request before reads.
  undo: [uuid, commandId],
} satisfies Record<
  Exclude<
    keyof PlanningApplication,
    keyof ProjectionMethods | keyof ReminderMethods | 'previewPlanningZoneChange'
  >,
  readonly InputCheck[]
>;

const reference = (kind: string) => object({ kind: choice(kind), ...idRevision });
const alignmentRef = object({
  kind: choice('axis', 'outcome', 'project', 'milestone'),
  ...idRevision,
});
const axis = {
  title: string,
  purpose: optional(string),
  color: optional(string),
  icon: optional(string),
};
const outcome = {
  title: string,
  successDefinition: string,
  targetStart: optionalDate,
  targetEnd: optionalDate,
};
const project = {
  title: string,
  desiredResult: optional(string),
  description: optional(string),
  notes: optional(string),
  targetStart: optionalDate,
  targetEnd: optionalDate,
};
const milestone = {
  title: string,
  measurableCheckpoint: string,
  targetStart: optionalDate,
  targetEnd: optionalDate,
};
const progress = union(
  object({ mode: choice('none', 'milestone_derived') }),
  object({ mode: choice('manual'), percentage: integer }),
);
const scope = union(
  object({ container: choice('axes') }),
  object({ container: choice('axis_outcomes', 'axis_projects'), axisId: nullable(uuid) }),
  object({ container: choice('outcome_milestones'), outcomeId: uuid }),
  object({ container: choice('project_actions'), projectId: uuid }),
);
const link = union(
  object({
    relationship: choice('axis_outcome'),
    axisId: uuid,
    outcome: reference('outcome'),
    replaceExisting: optional(boolean),
  }),
  object({
    relationship: choice('axis_project'),
    axisId: uuid,
    project: reference('project'),
    replaceExisting: optional(boolean),
  }),
  object({
    relationship: choice('outcome_primary_project'),
    outcomeId: uuid,
    project: reference('project'),
    replaceExisting: optional(boolean),
  }),
  object({ relationship: choice('outcome_secondary_project'), outcomeId: uuid, projectId: uuid }),
  object({ relationship: choice('milestone_project'), milestoneId: uuid, projectId: uuid }),
  object({ relationship: choice('milestone_action'), milestoneId: uuid, actionId: uuid }),
  object({
    relationship: choice('project_action'),
    projectId: uuid,
    action: reference('action'),
    replaceExisting: optional(boolean),
    confirmCrossAxis: optional(boolean),
  }),
);
const unlink = union(
  object({ relationship: choice('axis_outcome'), outcome: reference('outcome') }),
  object({
    relationship: choice('axis_project', 'outcome_primary_project'),
    project: reference('project'),
  }),
  object({ relationship: choice('project_action'), action: reference('action') }),
  object({
    relationship: choice('outcome_secondary_project', 'milestone_project', 'milestone_action'),
    linkId: uuid,
    revision,
  }),
);

export const alignmentInputContracts = {
  createAxis: [object(axis), commandId],
  editAxis: [reference('axis'), object(axis), commandId],
  createOutcome: [
    object({ ...outcome, axisId: optionalId, progress: optional(progress) }),
    commandId,
  ],
  editOutcome: [reference('outcome'), object(outcome), commandId],
  setOutcomeProgress: [reference('outcome'), progress, commandId],
  transitionOutcome: [
    reference('outcome'),
    choice('active', 'paused', 'achieved', 'abandoned'),
    commandId,
  ],
  createProject: [
    object({
      ...project,
      axisId: optionalId,
      primaryOutcomeId: optionalId,
      state: optional(choice('idea', 'active')),
    }),
    commandId,
  ],
  editProject: [reference('project'), object(project), commandId],
  transitionProject: [
    reference('project'),
    choice('active', 'blocked', 'paused', 'completed'),
    commandId,
  ],
  createMilestone: [object({ ...milestone, outcomeId: uuid }), commandId],
  editMilestone: [reference('milestone'), object(milestone), commandId],
  transitionMilestone: [
    reference('milestone'),
    choice('active', 'completed', 'canceled'),
    commandId,
  ],
  reparentMilestone: [reference('milestone'), uuid, commandId],
  reorder: [
    object({
      target: object({
        kind: choice('axis', 'outcome', 'project', 'milestone', 'action'),
        ...idRevision,
      }),
      direction,
      scope,
    }),
    commandId,
  ],
  link: [link, commandId],
  unlink: [unlink, commandId],
  archive: [alignmentRef, commandId],
  restore: [alignmentRef, commandId],
  deletePermanently: [
    object({
      target: alignmentRef,
      policy: choice('restrict', 'unlink_and_delete'),
      confirmation: string,
    }),
    commandId,
  ],
} satisfies Record<
  Exclude<
    keyof AlignmentApplication,
    | keyof AlignmentProjectionMethods
    | 'previewLink'
    | 'previewArchive'
    | 'previewRestore'
    | 'previewDelete'
  >,
  readonly InputCheck[]
>;

/** Today already checks values with precise errors; add only its missing closed field sets. */
const closedFields =
  (fields: Readonly<Record<string, InputCheck>>): InputCheck =>
  (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return true;
    return object(
      Object.fromEntries(Object.entries(fields).map(([key, check]) => [key, optional(check)])),
    )(value);
  };
const nestedList =
  (check: InputCheck): InputCheck =>
  (value) =>
    !Array.isArray(value) || value.every(check);
const closedPeriod: InputCheck = (value) =>
  isInputRecord(value) && value['kind'] === 'date'
    ? closedFields({ kind: raw, date: raw })(value)
    : closedFields({ kind: raw, start: raw, end: raw, weekStart: raw, targetCount: raw })(value);
const closedOccurrence = closedFields({
  routineId: raw,
  generation: raw,
  revision: raw,
  period: closedPeriod,
});
const closedFocus: InputCheck = (value) =>
  isInputRecord(value) && value['kind'] === 'action'
    ? closedFields({ kind: raw, actionId: raw })(value)
    : closedFields({ kind: raw, occurrence: closedOccurrence })(value);
const closedDecision: InputCheck = (value) =>
  isInputRecord(value) && value['kind'] === 'move'
    ? closedFields({ kind: raw, period: closedFields({ kind: raw, date: raw }) })(value)
    : closedFields({ kind: raw })(value);

export const todayInputContracts = {
  addFocus: [closedFields({ date: raw, target: closedFocus }), commandId],
  removeFocus: [closedFields({ selectionId: raw, revision: raw }), commandId],
  reorderFocus: [closedFields({ selectionId: raw, revision: raw, direction: raw }), commandId],
  setDayFocus: [closedFields({ date: raw, items: nestedList(closedFocus) }), commandId],
  reorderFlexible: [
    closedFields({ date: raw, placementId: raw, revision: raw, direction: raw }),
    commandId,
  ],
  applyEndDay: [
    closedFields({
      date: raw,
      carryTo: raw,
      actions: nestedList(closedFields({ actionId: raw, revision: raw, decision: closedDecision })),
      occurrences: nestedList(
        closedFields({ occurrence: closedOccurrence, decision: closedFields({ kind: raw }) }),
      ),
      nextFocus: nestedList(closedFocus),
    }),
    commandId,
  ],
} satisfies Record<
  Exclude<keyof TodayApplication, 'getToday' | 'getFocusChoices' | 'getFocusSession' | 'getEndDay'>,
  readonly InputCheck[]
>;
