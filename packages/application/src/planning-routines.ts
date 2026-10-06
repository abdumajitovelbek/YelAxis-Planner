import {
  completeOccurrenceProgress,
  createEntityRef,
  currentPlanningDate,
  err,
  localDateOf,
  materializedOnOrAfter,
  ok,
  parseCalendarDate,
  parseRoutineDefinition,
  parseRoutineReminderRequest,
  parseRoutineSchedulingMode,
  parseUUID,
  planRoutinePause,
  planRoutineResume,
  planRoutineSplit,
  reopenOccurrenceProgress,
  restoreLifecycle,
  routineLimits,
  skipOccurrenceProgress,
  transitionLifecycle,
  validateRoutineActionDefaults,
  validateRoutineSnapshot,
  type CalendarDate,
  type CommandContext,
  type DomainChange,
  type DomainResult,
  type EntityRef,
  type Instant,
  type OccurrenceOverrideV1,
  type OwnerId,
  type RoutineDefinition,
  type RoutineReminderRequest,
  type RoutineSchedulingMode,
  type RoutineState,
  type IanaTimeZone,
  type UUID,
} from '@yelaxis/domain';

import type { ActionCanonicalDocument } from './actions';
import type {
  ApplicationResult,
  CanonicalMutation,
  CanonicalRecordState,
  CommandReceipt,
  ExpectedRevision,
} from './contracts';
import { executeCommand } from './execute-command';
import type {
  OccurrenceTargetInput,
  PlanningQueryPort,
  RoutineDocument,
  RoutineInput,
  RoutineOccurrenceDocument,
  TimeBlockDocument,
} from './planning-contracts';
import type { RoutineMethods } from './planning';
import {
  applyEventTypes,
  createMutation,
  domainFailure,
  invalid,
  notFound,
  parseId,
  planningChange,
  updateFrom,
  without,
  type CreatedRecord,
} from './planning-kit';
import {
  cancelRoutineReminder,
  readRoutineReminder,
  reminderEventTypes,
  routineReminderSchedule,
} from './planning-reminders';
import {
  confirmOccurrenceEdit,
  occurrenceChange,
  occurrenceRefFor,
  openOccurrence,
  prepareOccurrenceEdit,
  validateOccurrenceDocument,
  withProgress,
  type OpenedOccurrence,
} from './planning-routines-occurrences';
import {
  defaultsDocument,
  defaultsFieldsOf,
  hasDefaults,
  initialOrderKey,
  isActiveChoice,
  rejected,
  resolveActiveChoice,
  resolveDefaults,
  resolveOwner,
  routineDefaultsId,
  snapshotMetadata,
  transitionError,
  userEnvelope,
  type DefaultsFields,
} from './planning-routines-support';
import {
  collectPlannedTimedItems,
  occurrenceKey,
  overlapsFor,
  routineSnapshot,
} from './planning-timed-items';
import type { ApplicationDependencies, PlanningRecordReader } from './ports';

type PlanningResult = Promise<ApplicationResult<CommandReceipt>>;

const routineRef = (ownerId: OwnerId, id: UUID): EntityRef<'routine'> =>
  createEntityRef('routine', id, ownerId);

const defaultsRef = (
  ownerId: OwnerId,
  routineId: UUID,
  generation: number,
): EntityRef<'routine_action_defaults'> =>
  createEntityRef('routine_action_defaults', routineDefaultsId(routineId, generation), ownerId);

function definitionInput(input: RoutineInput): Parameters<typeof parseRoutineDefinition>[0] {
  return {
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    rule: input.rule,
    schedulingMode: input.schedulingMode,
  };
}

/** Domain snapshot check for a Routine document (every generation must hold). */
function validateRoutineDocument(
  id: UUID,
  ownerId: OwnerId,
  document: RoutineDocument,
  now: Instant,
): DomainResult<RoutineDocument> {
  if (document.generations.length === 0)
    return invalid('routine_generations', 'A Routine needs a schedule.');
  for (const [index, spec] of document.generations.entries()) {
    if (spec.generation !== index + 1)
      return invalid('routine_generations', 'The Routine schedule history is invalid.');
    const checked = validateRoutineSnapshot({
      ...snapshotMetadata(id, ownerId, now),
      title: document.title,
      ...(document.description === undefined ? {} : { description: document.description }),
      ...(document.axisId === undefined ? {} : { axisId: document.axisId }),
      generation: spec.generation,
      rule: spec.rule,
      schedulingMode: spec.schedulingMode,
      orderKey: document.orderKey,
      state: document.state,
      ...(document.stateBeforeArchive === undefined
        ? {}
        : { stateBeforeArchive: document.stateBeforeArchive }),
      ...(document.pauseEffectiveOn === undefined
        ? {}
        : { pauseEffectiveOn: document.pauseEffectiveOn }),
    });
    if (!checked.ok) return checked;
  }
  return ok(document);
}

function validateDefaults(
  ownerId: OwnerId,
  routineId: UUID,
  generation: number,
  fields: DefaultsFields,
  now: Instant,
): DomainResult<void> {
  const id = routineDefaultsId(routineId, generation);
  const checked = validateRoutineActionDefaults(
    { ...snapshotMetadata(id, ownerId, now), ...defaultsDocument(routineId, generation, fields) },
    {
      routineOwnerId: ownerId,
      ...(fields.projectId === undefined ? {} : { projectOwnerId: ownerId }),
    },
  );
  return checked.ok ? ok(undefined) : checked;
}

/** A reminder requested with a new Routine (Review): its id, minutes before, and planning zone. */
interface CreationReminder {
  readonly ref: EntityRef<'reminder'>;
  readonly request: RoutineReminderRequest;
  readonly planningTimeZone: IanaTimeZone;
}

/** Per-record event type of the reminder a Routine command writes. */
const reminderEventType =
  (eventType: string) =>
  (mutation: CanonicalMutation): string | undefined =>
    mutation.ref.type === 'reminder' ? eventType : undefined;

/**
 * Create a Routine (generation 1) plus optional generation-1 action defaults and an optional
 * reminder (only for a Routine at a set time) in one change.
 */
function routineCreation(
  ref: EntityRef<'routine'>,
  definition: RoutineDefinition,
  axisId: UUID | undefined,
  fields: DefaultsFields,
  context: CommandContext,
  eventType: string,
  reminder?: CreationReminder,
): DomainResult<DomainChange<readonly CanonicalMutation[]>> {
  const document: RoutineDocument = {
    title: definition.title,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(axisId === undefined ? {} : { axisId }),
    orderKey: initialOrderKey,
    state: 'active',
    generations: [
      { generation: 1, rule: definition.rule, schedulingMode: definition.schedulingMode },
    ],
  };
  const valid = validateRoutineDocument(ref.id, ref.ownerId, document, context.now);
  if (!valid.ok) return valid;
  const mutations: CanonicalMutation[] = [createMutation(ref, document)];
  const created: CreatedRecord[] = [{ ref, kind: 'routine' }];
  if (hasDefaults(fields)) {
    const validDefaults = validateDefaults(ref.ownerId, ref.id, 1, fields, context.now);
    if (!validDefaults.ok) return validDefaults;
    const target = defaultsRef(ref.ownerId, ref.id, 1);
    mutations.push(createMutation(target, defaultsDocument(ref.id, 1, fields)));
    created.push({ ref: target, kind: 'routine_action_defaults' });
  }
  if (reminder !== undefined) {
    const schedule = routineReminderSchedule({
      routineId: ref.id,
      document,
      materialized: [],
      planningTimeZone: reminder.planningTimeZone,
      now: context.now,
      minutesBefore: reminder.request.minutesBefore,
    });
    if (!schedule.ok) return schedule;
    mutations.push(
      createMutation(reminder.ref, {
        routineId: ref.id,
        schedule: schedule.value,
        state: 'scheduled',
      }),
    );
    created.push({ ref: reminder.ref, kind: 'reminder' });
  }
  return ok(
    applyEventTypes(
      planningChange(mutations, context, eventType, { created }),
      mutations,
      reminderEventType(reminderEventTypes.set),
    ),
  );
}

interface GenerationDefaultsWrite {
  readonly mutations: readonly CanonicalMutation[];
  readonly prior: readonly CanonicalRecordState[];
  readonly created: readonly CreatedRecord[];
}

/**
 * Defaults for a newly started generation. A defaults row for that generation may survive an
 * earlier undone split (undo never deletes), so it is updated rather than duplicated.
 */
async function writeGenerationDefaults(
  records: PlanningRecordReader,
  ownerId: OwnerId,
  routineId: UUID,
  generation: number,
  fields: DefaultsFields,
  now: Instant,
): Promise<DomainResult<GenerationDefaultsWrite>> {
  const ref = defaultsRef(ownerId, routineId, generation);
  const existing = await records.read(ref);
  const document = defaultsDocument(routineId, generation, fields);
  if (hasDefaults(fields)) {
    const valid = validateDefaults(ownerId, routineId, generation, fields, now);
    if (!valid.ok) return valid;
  }
  if (existing !== null)
    return ok({ mutations: [updateFrom(existing, document)], prior: [existing], created: [] });
  if (!hasDefaults(fields)) return ok({ mutations: [], prior: [], created: [] });
  return ok({
    mutations: [createMutation(ref, document)],
    prior: [],
    created: [{ ref, kind: 'routine_action_defaults' }],
  });
}

const trimmedOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

async function readRoutine(
  records: PlanningRecordReader,
  ref: EntityRef<'routine'>,
): Promise<
  DomainResult<{ readonly record: CanonicalRecordState; readonly document: RoutineDocument }>
> {
  const record = await records.read(ref);
  if (record === null)
    return err({ code: 'invalid_value', message: 'The Routine no longer exists.' });
  return ok({ record, document: record.document as RoutineDocument });
}

interface SplitExtra {
  readonly selectedOn: CalendarDate;
  readonly mode: RoutineSchedulingMode;
  readonly fields: DefaultsFields | undefined;
  readonly zone: IanaTimeZone;
}

/** Upper bound for "on or after" occurrence lookups; a Routine may run without an end date. */
const openEnded = '9999-12-31' as CalendarDate;

interface DateExtra {
  readonly date: CalendarDate;
  readonly zone: IanaTimeZone;
}

const archivedRoutine = (): DomainResult<never> =>
  transitionError('routine_archived', 'Restore the Routine before changing it.');

/** The optional reminder of a new Routine, checked strictly; absent creates none. */
function parseCreationReminder(value: unknown): DomainResult<RoutineReminderRequest | undefined> {
  return value === undefined ? ok(undefined) : parseRoutineReminderRequest(value);
}

export function createRoutineCommands(
  dependencies: ApplicationDependencies,
  queries: PlanningQueryPort,
): RoutineMethods {
  /** The reminder a new Routine is created with: its id and the planning zone it resolves in. */
  const creationReminder = async (
    ownerId: OwnerId,
    request: RoutineReminderRequest | undefined,
  ): Promise<CreationReminder | undefined> =>
    request === undefined
      ? undefined
      : {
          ref: createEntityRef('reminder', dependencies.ids.next(), ownerId),
          request,
          planningTimeZone: (await queries.getPlanProfile(ownerId)).planningTimeZone,
        };

  /** Shared shape of a single-Routine update: owner, id, existence, and expected revision. */
  const routineUpdate = async <Extra>(
    routineIdValue: string,
    revision: number,
    prepare: (
      ownerId: OwnerId,
      ref: EntityRef<'routine'>,
    ) => Promise<
      ApplicationResult<{ readonly extra: Extra; readonly expected: readonly ExpectedRevision[] }>
    >,
    commandId: Parameters<RoutineMethods['archiveRoutine']>[1],
    eventType: string,
    plan: (request: {
      readonly current: CanonicalRecordState;
      readonly document: RoutineDocument;
      readonly records: PlanningRecordReader;
      readonly context: CommandContext;
      readonly extra: Extra;
    }) => Promise<
      DomainResult<
        GenerationDefaultsWrite & {
          readonly next: RoutineDocument;
          /** Event type of a changed record other than the Routine (for example its reminder). */
          readonly eventTypeFor?: (mutation: CanonicalMutation) => string | undefined;
        }
      >
    >,
  ): PlanningResult => {
    const owner = await resolveOwner(dependencies);
    if (!owner.ok) return owner;
    const ownerId = owner.value;
    const id = parseUUID(routineIdValue);
    if (!id.ok) return domainFailure(id);
    const ref = routineRef(ownerId, id.value);
    const existing = await queries.readRecord(ownerId, ref);
    if (existing === null) return notFound(ref);
    const prepared = await prepare(ownerId, ref);
    if (!prepared.ok) return prepared;
    return executeCommand(
      dependencies,
      userEnvelope(
        dependencies,
        ownerId,
        commandId,
        [{ ref, revision }, ...prepared.value.expected],
        {
          ref,
        },
      ),
      async ({ input, records, context }) => {
        const loaded = await readRoutine(records, input.ref);
        if (!loaded.ok) return loaded;
        const planned = await plan({
          current: loaded.value.record,
          document: loaded.value.document,
          records,
          context,
          extra: prepared.value.extra,
        });
        if (!planned.ok) return planned;
        const valid = validateRoutineDocument(
          input.ref.id,
          ownerId,
          planned.value.next,
          context.now,
        );
        if (!valid.ok) return valid;
        const mutations = [
          updateFrom(loaded.value.record, planned.value.next),
          ...planned.value.mutations,
        ];
        return ok(
          applyEventTypes(
            planningChange(mutations, context, eventType, {
              prior: [loaded.value.record, ...planned.value.prior],
              created: planned.value.created,
            }),
            mutations,
            planned.value.eventTypeFor,
          ),
        );
      },
    );
  };

  const noExtra = (): Promise<
    ApplicationResult<{ readonly extra: undefined; readonly expected: readonly ExpectedRevision[] }>
  > => Promise.resolve({ ok: true, value: { extra: undefined, expected: [] } });

  const unchanged = { mutations: [], prior: [], created: [] } as const;

  /**
   * A new generation starting on `effectiveOn` would generate periods again that the current
   * generation already materialized (completed, skipped, moved, or acknowledged) on or after that
   * date, counting them twice. Such a change is rejected so history is never rewritten.
   */
  const guardLaterOccurrences = async (
    ownerId: OwnerId,
    ref: EntityRef<'routine'>,
    generation: number,
    effectiveOn: CalendarDate,
  ): Promise<ApplicationResult<void>> => {
    const rows = await queries.listMaterializedOccurrences(
      ownerId,
      { start: effectiveOn, end: openEnded },
      ref.id,
    );
    const blocking = materializedOnOrAfter(rows, generation, effectiveOn)[0];
    if (blocking === undefined) return { ok: true, value: undefined };
    const firstDate =
      blocking.period.kind === 'date' ? blocking.period.date : blocking.period.start;
    return rejected(
      'materialized_occurrences_after_split',
      { date: firstDate },
      `The occurrence on ${firstDate} was already changed or completed. Choose a date after it.`,
    );
  };

  /**
   * Expected revision for the defaults row of the generation a split or resume would start, when
   * that row already exists (for example after an undone split).
   */
  const nextGenerationExpectation = async (
    ownerId: OwnerId,
    ref: EntityRef<'routine'>,
  ): Promise<readonly ExpectedRevision[]> => {
    const record = await queries.readRecord(ownerId, ref);
    if (record === null) return [];
    const document = record.document as RoutineDocument;
    const next = (document.generations.at(-1)?.generation ?? 0) + 1;
    const target = defaultsRef(ownerId, ref.id, next);
    const existing = await queries.readRecord(ownerId, target);
    return existing === null ? [] : [{ ref: target, revision: existing.localRevision }];
  };

  const runOccurrence = async (
    target: OccurrenceTargetInput,
    commandId: Parameters<RoutineMethods['completeOccurrence']>[1],
    eventType: string,
    transform: (
      opened: OpenedOccurrence,
      context: CommandContext,
    ) => DomainResult<RoutineOccurrenceDocument>,
  ): PlanningResult => {
    const owner = await resolveOwner(dependencies);
    if (!owner.ok) return owner;
    const ownerId = owner.value;
    const ref = occurrenceRefFor(ownerId, target);
    if (!ref.ok) return domainFailure(ref);
    const expected: ExpectedRevision[] =
      target.revision === undefined ? [] : [{ ref: ref.value, revision: target.revision }];
    return executeCommand(
      dependencies,
      userEnvelope(dependencies, ownerId, commandId, expected, target),
      async ({ input, records, context }) => {
        const opened = await openOccurrence(records, ownerId, input);
        if (!opened.ok) return opened;
        const next = transform(opened.value, context);
        if (!next.ok) return next;
        const valid = validateOccurrenceDocument(opened.value.ref, next.value, context.now);
        if (!valid.ok) return valid;
        return ok(
          occurrenceChange(
            [{ opened: opened.value, document: next.value }],
            [],
            context,
            eventType,
          ),
        );
      },
    );
  };

  return {
    async createRoutine(input, commandId) {
      const owner = await resolveOwner(dependencies);
      if (!owner.ok) return owner;
      const ownerId = owner.value;
      const definition = parseRoutineDefinition(definitionInput(input));
      if (!definition.ok) return domainFailure(definition);
      const reminderRequest = parseCreationReminder(input.reminder);
      if (!reminderRequest.ok) return domainFailure(reminderRequest);
      const axis = await resolveActiveChoice(queries, ownerId, 'axis', input.axisId);
      if (!axis.ok) return domainFailure(axis);
      const defaults = await resolveDefaults(queries, ownerId, input.defaults ?? {});
      if (!defaults.ok) return domainFailure(defaults);
      const ref = routineRef(ownerId, dependencies.ids.next());
      const reminder = await creationReminder(ownerId, reminderRequest.value);
      return executeCommand(
        dependencies,
        userEnvelope(dependencies, ownerId, commandId, [], { ref }),
        ({ input: request, context }) =>
          routineCreation(
            request.ref,
            definition.value,
            axis.value,
            defaults.value,
            context,
            'routine.created',
            reminder,
          ),
      );
    },

    async repeatAfterAction(input, commandId) {
      const owner = await resolveOwner(dependencies);
      if (!owner.ok) return owner;
      const ownerId = owner.value;
      const actionId = parseUUID(input.actionId);
      if (!actionId.ok) return domainFailure(actionId);
      const actionRef = createEntityRef('action', actionId.value, ownerId);
      const actionRecord = await queries.readRecord(ownerId, actionRef);
      if (actionRecord === null) return notFound(actionRef);
      const action = actionRecord.document as ActionCanonicalDocument;
      const definition = parseRoutineDefinition(definitionInput(input));
      if (!definition.ok) return domainFailure(definition);
      const reminderRequest = parseCreationReminder(input.reminder);
      if (!reminderRequest.ok) return domainFailure(reminderRequest);

      // The Routine begins after the Action's own date so the Action stays a separate one-off.
      const profile = await queries.getPlanProfile(ownerId);
      const summary = await queries.getAction(ownerId, actionId.value);
      let reference: CalendarDate;
      if (summary?.placement?.period.kind === 'day') {
        reference = summary.placement.period.date;
      } else {
        const block = await queries.getPlannedActionBlock(ownerId, actionId.value);
        if (block !== null) {
          reference = localDateOf(
            (block.document as TimeBlockDocument).startsAt,
            profile.planningTimeZone,
          );
        } else if (action.due?.kind === 'date') {
          reference = action.due.date;
        } else {
          reference = currentPlanningDate(dependencies.clock, profile.planningTimeZone);
        }
      }
      if (definition.value.rule.startsOn <= reference)
        return domainFailure(
          invalid(
            'routine_must_start_after_action',
            'The repeating schedule must start after this Action.',
          ),
        );

      let axisId: UUID | undefined;
      if (input.axisId !== undefined) {
        const axis = await resolveActiveChoice(queries, ownerId, 'axis', input.axisId);
        if (!axis.ok) return domainFailure(axis);
        axisId = axis.value;
      } else if (
        action.axisId !== undefined &&
        (await isActiveChoice(queries, ownerId, 'axis', action.axisId))
      ) {
        axisId = action.axisId;
      }

      const provided = input.defaults ?? {};
      const copiedProject =
        provided.projectId === undefined &&
        action.projectId !== undefined &&
        (await isActiveChoice(queries, ownerId, 'project', action.projectId))
          ? action.projectId
          : undefined;
      const note = provided.note ?? action.note;
      const estimateMinutes = provided.estimateMinutes ?? action.estimateMinutes;
      const energy = provided.energy ?? action.energy;
      const priority = provided.priority ?? action.priority;
      const projectId = provided.projectId ?? copiedProject;
      const defaults = await resolveDefaults(queries, ownerId, {
        ...(projectId === undefined ? {} : { projectId }),
        ...(note === undefined ? {} : { note }),
        ...(estimateMinutes === undefined ? {} : { estimateMinutes }),
        ...(energy === undefined ? {} : { energy }),
        ...(priority === undefined ? {} : { priority }),
      });
      if (!defaults.ok) return domainFailure(defaults);

      const ref = routineRef(ownerId, dependencies.ids.next());
      const reminder = await creationReminder(ownerId, reminderRequest.value);
      return executeCommand(
        dependencies,
        userEnvelope(dependencies, ownerId, commandId, [], { ref, actionRef }),
        async ({ input: request, records, context }) => {
          // The Action is read to confirm it still exists; it is never modified.
          if ((await records.read(request.actionRef)) === null)
            return err({ code: 'invalid_value', message: 'The Action no longer exists.' });
          return routineCreation(
            request.ref,
            definition.value,
            axisId,
            defaults.value,
            context,
            'routine.created_from_action',
            reminder,
          );
        },
      );
    },

    editRoutineDetails(input, commandId) {
      const title = input.title.trim();
      const description = trimmedOrUndefined(input.description);
      return routineUpdate<UUID | undefined>(
        input.routineId,
        input.revision,
        async (ownerId, ref) => {
          if (title.length === 0 || title.length > routineLimits.title)
            return domainFailure(invalid('title', 'Enter a title up to 200 characters.'));
          if (description !== undefined && description.length > routineLimits.description)
            return domainFailure(invalid('description'));
          const axis = parseId(input.axisId);
          if (!axis.ok) return domainFailure(axis);
          const current = await queries.readRecord(ownerId, ref);
          const currentAxis = (current?.document as RoutineDocument | undefined)?.axisId;
          if (axis.value !== undefined && axis.value !== currentAxis) {
            const active = await resolveActiveChoice(queries, ownerId, 'axis', axis.value);
            if (!active.ok) return domainFailure(active);
          }
          return { ok: true, value: { extra: axis.value, expected: [] } };
        },
        commandId,
        'routine.details_edited',
        ({ document, extra }) => {
          if (document.state === 'archived') return Promise.resolve(archivedRoutine());
          const base = without(without(document, 'description'), 'axisId');
          const next: RoutineDocument = {
            ...base,
            title,
            ...(description === undefined ? {} : { description }),
            ...(extra === undefined ? {} : { axisId: extra }),
          };
          return Promise.resolve(ok({ ...unchanged, next }));
        },
      );
    },

    editRoutineThisAndFuture(input, commandId) {
      return routineUpdate<SplitExtra>(
        input.routineId,
        input.revision,
        async (ownerId, ref) => {
          const selectedOn = parseCalendarDate(input.selectedOn);
          if (!selectedOn.ok) return domainFailure(selectedOn);
          const mode = parseRoutineSchedulingMode(input.schedulingMode);
          if (!mode.ok) return domainFailure(mode);
          let fields: DefaultsFields | undefined;
          if (input.defaults !== undefined) {
            const defaults = await resolveDefaults(queries, ownerId, input.defaults);
            if (!defaults.ok) return domainFailure(defaults);
            fields = defaults.value;
          }
          const profile = await queries.getPlanProfile(ownerId);
          const record = await queries.readRecord(ownerId, ref);
          const current = (record?.document as RoutineDocument | undefined)?.generations.at(-1);
          if (current !== undefined) {
            const today = currentPlanningDate(dependencies.clock, profile.planningTimeZone);
            // Date checks (past, before/after the current schedule) answer first.
            if (selectedOn.value >= today && selectedOn.value > current.rule.startsOn) {
              const guard = await guardLaterOccurrences(
                ownerId,
                ref,
                current.generation,
                selectedOn.value,
              );
              if (!guard.ok) return guard;
            }
          }
          return {
            ok: true,
            value: {
              extra: {
                selectedOn: selectedOn.value,
                mode: mode.value,
                fields,
                zone: profile.planningTimeZone,
              },
              expected: await nextGenerationExpectation(ownerId, ref),
            },
          };
        },
        commandId,
        'routine.split',
        async ({ current, document, records, context, extra }) => {
          const split = planRoutineSplit(
            routineSnapshot({ id: current.ref.id, document }),
            extra.selectedOn,
            input.rule,
            extra.mode,
            currentPlanningDate({ now: () => context.now }, extra.zone),
          );
          if (!split.ok) return split;
          const previous = document.generations.at(-1);
          const created = split.value.generations.at(-1);
          if (previous === undefined || created === undefined)
            return invalid('routine_generations');
          let fields = extra.fields;
          if (fields === undefined) {
            // New generation defaults continue the current generation's defaults unless replaced.
            const prior = await records.read(
              defaultsRef(current.ref.ownerId, current.ref.id, previous.generation),
            );
            fields = prior === null ? {} : defaultsFieldsOf(prior.document);
          }
          const defaults = await writeGenerationDefaults(
            records,
            current.ref.ownerId,
            current.ref.id,
            created.generation,
            fields,
            context.now,
          );
          if (!defaults.ok) return defaults;
          return ok({
            ...defaults.value,
            next: { ...document, generations: split.value.generations },
          });
        },
      );
    },

    pauseRoutine(input, commandId) {
      return routineUpdate<DateExtra>(
        input.routineId,
        input.revision,
        async (ownerId) => {
          const pauseOn = parseCalendarDate(input.pauseOn);
          if (!pauseOn.ok) return domainFailure(pauseOn);
          const profile = await queries.getPlanProfile(ownerId);
          return {
            ok: true,
            value: {
              extra: { date: pauseOn.value, zone: profile.planningTimeZone },
              expected: [],
            },
          };
        },
        commandId,
        'routine.paused',
        ({ current, document, context, extra }) => {
          const today = currentPlanningDate({ now: () => context.now }, extra.zone);
          const paused = planRoutinePause(
            routineSnapshot({ id: current.ref.id, document }),
            extra.date,
            today,
          );
          if (!paused.ok) return Promise.resolve(paused);
          return Promise.resolve(
            ok({
              ...unchanged,
              next: {
                ...document,
                state: 'paused' as const,
                pauseEffectiveOn: paused.value.pauseEffectiveOn,
              },
            }),
          );
        },
      );
    },

    resumeRoutine(input, commandId) {
      return routineUpdate<DateExtra>(
        input.routineId,
        input.revision,
        async (ownerId, ref) => {
          const resumeOn = parseCalendarDate(input.resumeOn);
          if (!resumeOn.ok) return domainFailure(resumeOn);
          const profile = await queries.getPlanProfile(ownerId);
          const record = await queries.readRecord(ownerId, ref);
          if (record !== null) {
            const document = record.document as RoutineDocument;
            const resumed = planRoutineResume(
              routineSnapshot({ id: ref.id, document }),
              resumeOn.value,
              currentPlanningDate(dependencies.clock, profile.planningTimeZone),
            );
            const previous = document.generations.at(-1);
            // Only a resume that starts a new generation can generate a period twice.
            if (
              resumed.ok &&
              previous !== undefined &&
              resumed.value.generations.length > document.generations.length
            ) {
              const guard = await guardLaterOccurrences(
                ownerId,
                ref,
                previous.generation,
                resumeOn.value,
              );
              if (!guard.ok) return guard;
            }
          }
          return {
            ok: true,
            value: {
              extra: { date: resumeOn.value, zone: profile.planningTimeZone },
              expected: await nextGenerationExpectation(ownerId, ref),
            },
          };
        },
        commandId,
        'routine.resumed',
        async ({ current, document, records, context, extra }) => {
          const today = currentPlanningDate({ now: () => context.now }, extra.zone);
          const resumed = planRoutineResume(
            routineSnapshot({ id: current.ref.id, document }),
            extra.date,
            today,
          );
          if (!resumed.ok) return resumed;
          const next: RoutineDocument = {
            ...without(document, 'pauseEffectiveOn'),
            state: 'active',
            generations: resumed.value.generations,
          };
          const previous = document.generations.at(-1);
          const started = resumed.value.generations.at(-1);
          if (
            previous === undefined ||
            started === undefined ||
            started.generation === previous.generation
          )
            return ok({ ...unchanged, next });
          // Missed dates are never backfilled: the new generation starts on the resume date and
          // carries the same action defaults forward.
          const prior = await records.read(
            defaultsRef(current.ref.ownerId, current.ref.id, previous.generation),
          );
          const defaults = await writeGenerationDefaults(
            records,
            current.ref.ownerId,
            current.ref.id,
            started.generation,
            prior === null ? {} : defaultsFieldsOf(prior.document),
            context.now,
          );
          if (!defaults.ok) return defaults;
          return ok({ ...defaults.value, next });
        },
      );
    },

    archiveRoutine(input, commandId) {
      return routineUpdate<CanonicalRecordState | null>(
        input.routineId,
        input.revision,
        // The archive policy's stated sub-operation: a scheduled reminder of the
        // Routine is turned off in the same command; restoring never turns it back on.
        async (ownerId, ref) => {
          const reminder = await readRoutineReminder(queries, ownerId, ref.id);
          return {
            ok: true,
            value: {
              extra: reminder,
              expected:
                reminder === null ? [] : [{ ref: reminder.ref, revision: reminder.localRevision }],
            },
          };
        },
        commandId,
        'routine.archived',
        async ({ current, document, records, context, extra }) => {
          const transition = transitionLifecycle({
            entityType: 'routine',
            current: { state: document.state },
            to: 'archived',
          });
          if (!transition.ok) return transition;
          const reminder = await cancelRoutineReminder(records, extra, current.ref.id);
          if (!reminder.ok) return reminder;
          return ok({
            mutations: reminder.value === null ? [] : [reminder.value.mutation],
            prior: reminder.value === null ? [] : [reminder.value.prior],
            created: [],
            next: {
              ...document,
              state: 'archived' as const,
              stateBeforeArchive: document.state as Exclude<RoutineState, 'archived'>,
              archivedAt: context.now,
            },
            eventTypeFor: reminderEventType(reminderEventTypes.canceled),
          });
        },
      );
    },

    restoreRoutine(input, commandId) {
      return routineUpdate<undefined>(
        input.routineId,
        input.revision,
        noExtra,
        commandId,
        'routine.restored',
        ({ document }) => {
          if (document.state !== 'archived')
            return Promise.resolve(
              transitionError('routine_not_archived', 'Only an archived Routine can be restored.'),
            );
          const restored = restoreLifecycle('routine', {
            state: document.state,
            ...(document.stateBeforeArchive === undefined
              ? {}
              : { stateBeforeArchive: document.stateBeforeArchive }),
          });
          if (!restored.ok) return Promise.resolve(restored);
          const state = restored.value.state as RoutineState;
          const base = without(without(document, 'stateBeforeArchive'), 'archivedAt');
          const next: RoutineDocument =
            state === 'paused' && document.pauseEffectiveOn === undefined
              ? { ...base, state: 'active' }
              : { ...base, state };
          return Promise.resolve(ok({ ...unchanged, next }));
        },
      );
    },

    completeOccurrence(input, commandId) {
      return runOccurrence(
        input.occurrence,
        commandId,
        'routine_occurrence.completed',
        (opened, context) => {
          const progress = completeOccurrenceProgress(opened.progress, {
            confirmExtra: input.confirmExtra === true,
          });
          if (!progress.ok) return progress;
          return ok(withProgress(opened.document, progress.value, context.now));
        },
      );
    },

    skipOccurrence(input, commandId) {
      return runOccurrence(
        input.occurrence,
        commandId,
        'routine_occurrence.skipped',
        (opened, context) => {
          const progress = skipOccurrenceProgress(opened.progress);
          if (!progress.ok) return progress;
          return ok(withProgress(opened.document, progress.value, context.now));
        },
      );
    },

    reopenOccurrence(input, commandId) {
      return runOccurrence(
        input.occurrence,
        commandId,
        'routine_occurrence.reopened',
        (opened, context) => {
          const progress = reopenOccurrenceProgress(opened.progress);
          if (!progress.ok) return progress;
          return ok(withProgress(opened.document, progress.value, context.now));
        },
      );
    },

    async editOccurrence(input, commandId) {
      const owner = await resolveOwner(dependencies);
      if (!owner.ok) return owner;
      const ownerId = owner.value;
      const target = input.occurrence;
      const profile = await queries.getPlanProfile(ownerId);
      const prepared = await prepareOccurrenceEdit(
        queries,
        ownerId,
        profile.planningTimeZone,
        input,
      );
      if (!prepared.ok) return prepared;
      const ownRef = prepared.value.ref;
      const time = prepared.value.plan.time;
      const interval =
        time.kind === 'timed' ? { startsAt: time.startsAt, endsAt: time.endsAt } : undefined;

      const overlaps =
        interval === undefined
          ? []
          : overlapsFor(
              await collectPlannedTimedItems(
                queries,
                ownerId,
                profile.planningTimeZone,
                interval.startsAt,
                interval.endsAt,
              ),
              interval,
              [occurrenceKey(ownRef.id)],
            );
      if (overlaps.length > 0 && !input.overlapAcknowledged)
        return rejected(
          'overlap_requires_acknowledgement',
          { overlaps: overlaps.map(({ key, title }) => ({ key, title })) },
          'This time overlaps other planned work. Keep the overlap or choose another time.',
        );

      // Acknowledging an overlap marks this occurrence and each overlapped item.
      const pending = overlaps.filter((item) => !item.overlapAcknowledged);
      const blocks: { readonly ref: EntityRef<'time_block'>; readonly revision: number }[] = [];
      const others: OccurrenceTargetInput[] = [];
      for (const item of pending) {
        if (item.block !== undefined) {
          blocks.push({
            ref: createEntityRef('time_block', item.block.id, ownerId),
            revision: item.block.localRevision,
          });
        } else if (item.occurrence !== undefined) {
          const projected = item.occurrence.projected;
          others.push({
            routineId: projected.routineId,
            generation: projected.generation,
            period: projected.period,
            ...(projected.materialized && projected.localRevision !== undefined
              ? { revision: projected.localRevision }
              : {}),
          });
        }
      }
      const expected: ExpectedRevision[] = [
        ...(target.revision === undefined ? [] : [{ ref: ownRef, revision: target.revision }]),
        ...blocks,
        ...others.flatMap((other) => {
          if (other.revision === undefined) return [];
          const ref = occurrenceRefFor(ownerId, other);
          return ref.ok ? [{ ref: ref.value, revision: other.revision }] : [];
        }),
      ];
      const acknowledged = overlaps.length > 0;

      return executeCommand(
        dependencies,
        userEnvelope(dependencies, ownerId, commandId, expected, target),
        async ({ input: request, records, context }) => {
          const opened = await openOccurrence(records, ownerId, request);
          if (!opened.ok) return opened;
          if (opened.value.document.state !== 'planned')
            return transitionError(
              'occurrence_not_planned',
              'Reopen this occurrence before moving it.',
            );
          const override = confirmOccurrenceEdit(prepared.value, opened.value.document);
          if (!override.ok) return override;
          const finalOverride: OccurrenceOverrideV1 = {
            ...override.value,
            ...(acknowledged ? { overlapAcknowledged: true as const } : {}),
          };
          const base = without(opened.value.document, 'override');
          const document: RoutineOccurrenceDocument =
            Object.keys(finalOverride).length === 0 ? base : { ...base, override: finalOverride };
          const valid = validateOccurrenceDocument(opened.value.ref, document, context.now);
          if (!valid.ok) return valid;

          const extraMutations: CanonicalMutation[] = [];
          const extraPrior: CanonicalRecordState[] = [];
          for (const block of blocks) {
            const current = await records.read(block.ref);
            if (current === null)
              return err({ code: 'invalid_value', message: 'A planned block changed. Try again.' });
            const blockDocument = current.document as TimeBlockDocument;
            if (blockDocument.state !== 'planned')
              return err({ code: 'invalid_value', message: 'A planned block changed. Try again.' });
            extraMutations.push(
              updateFrom(current, { ...blockDocument, overlapAcknowledged: true }),
            );
            extraPrior.push(current);
          }
          const occurrenceUpdates: {
            opened: OpenedOccurrence;
            document: RoutineOccurrenceDocument;
          }[] = [{ opened: opened.value, document }];
          for (const other of others) {
            const otherOpened = await openOccurrence(records, ownerId, other);
            if (!otherOpened.ok) return otherOpened;
            occurrenceUpdates.push({
              opened: otherOpened.value,
              document: {
                ...otherOpened.value.document,
                override: {
                  ...(otherOpened.value.document.override ?? {}),
                  overlapAcknowledged: true,
                },
              },
            });
          }
          return ok(
            occurrenceChange(
              occurrenceUpdates,
              extraMutations.map((mutation, index) => ({
                mutation,
                prior: extraPrior[index] ?? null,
              })),
              context,
              'routine_occurrence.edited',
            ),
          );
        },
      );
    },
  };
}
