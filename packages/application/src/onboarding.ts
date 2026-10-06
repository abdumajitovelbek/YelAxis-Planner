import {
  createDayPeriod,
  createWeekPeriod,
  currentPlanningDate,
  emptyOnboardingDraft,
  onboardingSteps,
  parseIanaTimeZone,
  parseInstant,
  parseWallTime,
  resolveFloatingDateTime,
  validateOnboardingDraft,
  validateOnboardingStep,
  type Clock,
  type HandbookStatus,
  type IdProvider,
  type Instant,
  type OnboardingDraft,
  type OnboardingStatus,
  type OnboardingStep,
  type OwnerId,
  type ProfileId,
  type UUID,
} from '@yelaxis/domain';
import {
  inputBoolean,
  inputChoice,
  inputInteger,
  inputList,
  inputObject,
  inputString,
  inputUnion,
  optionalInput,
} from './runtime-input';

export type OnboardingArtifacts = Readonly<{
  axisIds: readonly UUID[];
  outcomeId?: UUID;
  actionId?: UUID;
  placementId?: UUID;
  focusId?: UUID;
  weekSelectionId?: UUID;
  awakeContextId?: UUID;
  availabilityContextId?: UUID;
  availabilityConstraintId?: UUID;
  boundaryContextId?: UUID;
  commitments: readonly Readonly<{ commitmentId: UUID; timeBlockId: UUID }>[];
}>;

export type OnboardingTodayProjection = Readonly<{
  date: string;
  weekStartDate: string;
  weekEndDate: string;
  preferredName?: string;
  axes: readonly Readonly<{ id: string; title: string }>[];
  outcome?: Readonly<{ id: string; title: string; successDefinition: string; axisTitle?: string }>;
  action?: Readonly<{ id: string; title: string }>;
  commitments: readonly Readonly<{
    id: string;
    title: string;
    strength: 'hard' | 'soft';
    startsAtUtc: string;
    endsAtUtc: string;
    timeZone: string;
  }>[];
}>;

export type OnboardingState = Readonly<{
  ownerId: OwnerId;
  profileId: ProfileId;
  profileRevision: number;
  status: OnboardingStatus;
  step: OnboardingStep;
  completedSteps: readonly OnboardingStep[];
  skippedSteps: readonly OnboardingStep[];
  defaultsConfirmedAt?: Instant;
  completedAt?: Instant;
  handbook: Readonly<{
    status: HandbookStatus;
    lesson: number;
    completedLessons: readonly number[];
  }>;
  draft: OnboardingDraft;
  artifacts: OnboardingArtifacts;
  today: OnboardingTodayProjection;
}>;

/**
 * The first-plan records of an onboarding commit. `placement`, `focus`, and `week_selection` are
 * sent only with a new starter Action, and persistence only ever inserts them: an id that was
 * permanently deleted or is already taken, or a day that already has three active focus items,
 * leaves that record out.
 */
export type OnboardingRecordMutation =
  | Readonly<{ kind: 'axis'; id: UUID; title: string; sortKey: string }>
  | Readonly<{
      kind: 'outcome';
      id: UUID;
      axisId?: UUID;
      title: string;
      successDefinition: string;
      targetDate?: string;
      sortKey: string;
    }>
  | Readonly<{
      kind: 'context';
      id: UUID;
      category: 'availability' | 'boundaries';
      contextKey: string;
      value: string;
      strength: 'hard' | 'soft' | 'unknown';
    }>
  | Readonly<{
      kind: 'constraint';
      id: UUID;
      contextId: UUID;
      strength: 'hard' | 'soft' | 'unknown';
      payload: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ kind: 'commitment'; id: UUID; title: string; strength: 'hard' | 'soft' }>
  | Readonly<{
      kind: 'time_block';
      id: UUID;
      commitmentId: UUID;
      startsAtUtc: Instant;
      endsAtUtc: Instant;
      timeZone: string;
    }>
  | Readonly<{ kind: 'action'; id: UUID; axisId?: UUID; title: string; sortKey: string }>
  | Readonly<{
      kind: 'placement';
      id: UUID;
      actionId: UUID;
      localDate: string;
      sortKey: string;
    }>
  | Readonly<{ kind: 'focus'; id: UUID; actionId: UUID; localDate: string; sortKey: string }>
  | Readonly<{
      kind: 'week_selection';
      id: UUID;
      actionId: UUID;
      startDate: string;
      endDate: string;
      weekStart: string;
      sortKey: string;
    }>;

export type OnboardingProfileMutation = Readonly<{
  preferredName?: string | undefined;
  localeOverride?: string | undefined;
  planningTimeZone: string;
  weekStart: string;
  timeFormat: '12_hour' | '24_hour';
  defaultsConfirmedAt?: Instant | undefined;
  status: OnboardingStatus;
  step: OnboardingStep;
  completedSteps: readonly OnboardingStep[];
  skippedSteps: readonly OnboardingStep[];
  draft: OnboardingDraft | null;
  artifacts: OnboardingArtifacts;
  completedAt?: Instant | undefined;
  handbook: OnboardingState['handbook'];
}>;

export type OnboardingCommit = Readonly<{
  commandId: UUID;
  ownerId: OwnerId;
  profileId: ProfileId;
  expectedProfileRevision: number;
  now: Instant;
  profile: OnboardingProfileMutation;
  records: readonly OnboardingRecordMutation[];
  eventType: string;
  eventIds: readonly UUID[];
  /**
   * The ids of the outbox group an account identity queues for this commit (account sync):
   * one operation id for the Profile and one for each record, by position like `eventIds`. Every
   * commit carries them; a local identity queues nothing.
   */
  outbox: Readonly<{ mutationGroupId: UUID; operationIds: readonly UUID[] }>;
}>;

export interface OnboardingPersistencePort {
  initialize(
    input: Readonly<{
      ownerId: OwnerId;
      profileId: ProfileId;
      now: Instant;
      defaults: OnboardingDraft['defaults'];
    }>,
  ): Promise<OnboardingState>;
  load(): Promise<OnboardingState | null>;
  commit(command: OnboardingCommit): Promise<OnboardingState>;
}

export type OnboardingCommand =
  | Readonly<{ kind: 'start'; draft: OnboardingDraft }>
  | Readonly<{
      kind: 'save_step';
      step: Exclude<OnboardingStep, 'welcome' | 'handbook'>;
      draft: OnboardingDraft;
      skipped?: boolean;
    }>
  | Readonly<{
      kind: 'save_handbook';
      status: HandbookStatus;
      lesson: number;
      completedLessons: readonly number[];
    }>
  | Readonly<{ kind: 'complete'; draft: OnboardingDraft; handbookStatus: HandbookStatus }>
  | Readonly<{ kind: 'rerun' }>
  | Readonly<{ kind: 'navigate'; step: OnboardingStep }>
  | Readonly<{ kind: 'reset_onboarding' }>
  | Readonly<{ kind: 'reset_handbook' }>;

export type OnboardingApplicationResult<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; message: string; field?: string }>;

export interface OnboardingApplication {
  initialize(defaults: NonNullable<OnboardingDraft['defaults']>): Promise<OnboardingState>;
  load(): Promise<OnboardingState | null>;
  execute(command: OnboardingCommand): Promise<OnboardingApplicationResult<OnboardingState>>;
}

export function createOnboardingApplication(
  persistence: OnboardingPersistencePort,
  dependencies: Readonly<{ clock: Clock; ids: IdProvider }>,
): OnboardingApplication {
  return {
    async initialize(defaults) {
      if (
        !inputObject({
          planningTimeZone: inputString,
          weekStart: inputString,
          timeFormat: inputString,
          locale: inputString,
        })(defaults)
      )
        throw new Error('Device planning defaults are not valid.');
      const validated = validateOnboardingStep('defaults', {
        ...emptyOnboardingDraft(),
        identity: { preferredName: '', locale: defaults.locale },
        defaults,
      });
      if (!validated.ok || validated.value.defaults === null) {
        throw new Error('Device planning defaults are not valid.');
      }
      return persistence.initialize({
        ownerId: dependencies.ids.next(),
        profileId: dependencies.ids.next(),
        now: dependencies.clock.now(),
        defaults: validated.value.defaults,
      });
    },
    load: () => persistence.load(),
    async execute(command) {
      if (!validOnboardingCommand(command))
        return {
          ok: false,
          message: 'Check the setup information and try again. Nothing was changed.',
        };
      const current = await persistence.load();
      if (current === null)
        return { ok: false, message: 'The local planning profile is unavailable.' };
      const built = buildCommit(current, command, dependencies.clock.now(), dependencies.ids);
      if (!built.ok) return built;
      try {
        return { ok: true, value: await persistence.commit(built.value) };
      } catch {
        return {
          ok: false,
          message: 'Your setup could not be saved. Nothing was partially changed; try again.',
        };
      }
    },
  };
}

const handbookStatusInput = inputChoice('not_started', 'in_progress', 'skipped', 'completed');
const draftInput = (value: unknown): boolean =>
  validateOnboardingStep('welcome', value as OnboardingDraft).ok;
const validOnboardingCommand = inputUnion(
  inputObject({ kind: inputChoice('start'), draft: draftInput }),
  inputObject({
    kind: inputChoice('save_step'),
    step: inputChoice('defaults', 'context', 'axes', 'outcome', 'week'),
    draft: draftInput,
    skipped: optionalInput(inputBoolean),
  }),
  inputObject({
    kind: inputChoice('save_handbook'),
    status: handbookStatusInput,
    lesson: inputInteger,
    completedLessons: inputList(inputInteger),
  }),
  inputObject({
    kind: inputChoice('complete'),
    draft: draftInput,
    handbookStatus: handbookStatusInput,
  }),
  inputObject({ kind: inputChoice('navigate'), step: inputChoice(...onboardingSteps) }),
  inputObject({ kind: inputChoice('rerun', 'reset_onboarding', 'reset_handbook') }),
);

function buildCommit(
  current: OnboardingState,
  command: OnboardingCommand,
  now: Instant,
  ids: IdProvider,
): OnboardingApplicationResult<OnboardingCommit> {
  const baseProfile = profileFromState(current);
  let profile = baseProfile;
  let records: readonly OnboardingRecordMutation[] = [];
  let eventType = `onboarding.${command.kind}`;

  if (command.kind === 'start') {
    const validated = validateOnboardingStep('welcome', command.draft);
    if (!validated.ok) return validationFailure(validated.error.details);
    profile = {
      ...baseProfile,
      preferredName: optional(validated.value.identity.preferredName),
      localeOverride: optional(validated.value.identity.locale),
      status: 'in_progress',
      step: 'defaults',
      completedSteps: addStep(current.completedSteps, 'welcome'),
      draft: validated.value,
    };
  } else if (command.kind === 'save_step') {
    const validated = validateOnboardingStep(command.step, command.draft);
    if (!validated.ok) return validationFailure(validated.error.details);
    const identityLocale = optional(
      validated.value.identity.locale || validated.value.defaults?.locale || '',
    );
    profile = {
      ...baseProfile,
      preferredName: optional(validated.value.identity.preferredName),
      ...(identityLocale === undefined ? {} : { localeOverride: identityLocale }),
      planningTimeZone: validated.value.defaults?.planningTimeZone ?? baseProfile.planningTimeZone,
      weekStart: validated.value.defaults?.weekStart ?? baseProfile.weekStart,
      timeFormat: validated.value.defaults?.timeFormat ?? baseProfile.timeFormat,
      ...(command.step === 'defaults' ? { defaultsConfirmedAt: now } : {}),
      status: 'in_progress',
      step: nextStep(command.step),
      completedSteps: addStep(current.completedSteps, command.step),
      skippedSteps: command.skipped
        ? addStep(current.skippedSteps, command.step)
        : current.skippedSteps.filter((step) => step !== command.step),
      draft: validated.value,
    };
  } else if (command.kind === 'save_handbook') {
    if (!validHandbookProgress(command.lesson, command.completedLessons)) {
      return { ok: false, message: 'The handbook progress is not valid.' };
    }
    profile = {
      ...baseProfile,
      handbook: {
        status: command.status,
        lesson: command.lesson,
        completedLessons: [...new Set(command.completedLessons)].sort(),
      },
    };
  } else if (command.kind === 'complete') {
    const validated = validateOnboardingDraft(command.draft);
    if (!validated.ok) return validationFailure(validated.error.details);
    const planned = buildPlanningRecords(current, validated.value, now, ids);
    if (!planned.ok) return planned;
    records = planned.value.records;
    const locale = optional(
      validated.value.identity.locale || validated.value.defaults?.locale || '',
    );
    profile = {
      ...baseProfile,
      preferredName: optional(validated.value.identity.preferredName),
      ...(locale === undefined ? {} : { localeOverride: locale }),
      planningTimeZone: validated.value.defaults?.planningTimeZone ?? baseProfile.planningTimeZone,
      weekStart: validated.value.defaults?.weekStart ?? baseProfile.weekStart,
      timeFormat: validated.value.defaults?.timeFormat ?? baseProfile.timeFormat,
      defaultsConfirmedAt: baseProfile.defaultsConfirmedAt ?? now,
      status: 'completed',
      step: 'handbook',
      completedSteps: addStep(current.completedSteps, 'handbook'),
      skippedSteps:
        command.handbookStatus === 'skipped'
          ? addStep(current.skippedSteps, 'handbook')
          : current.skippedSteps.filter((step) => step !== 'handbook'),
      draft: null,
      artifacts: planned.value.artifacts,
      completedAt: now,
      handbook: {
        ...current.handbook,
        status: command.handbookStatus,
        lesson: command.handbookStatus === 'completed' ? 4 : current.handbook.lesson,
        completedLessons:
          command.handbookStatus === 'completed' ? [0, 1, 2, 3] : current.handbook.completedLessons,
      },
    };
    eventType = 'onboarding.completed';
  } else if (command.kind === 'rerun') {
    profile = { ...baseProfile, status: 'in_progress', step: 'welcome', draft: current.draft };
  } else if (command.kind === 'navigate') {
    profile = { ...baseProfile, status: 'in_progress', step: command.step, draft: current.draft };
  } else if (command.kind === 'reset_onboarding') {
    profile = {
      ...baseProfile,
      status: 'not_started',
      step: 'welcome',
      completedSteps: [],
      skippedSteps: [],
      draft: current.draft,
      completedAt: undefined,
    };
  } else {
    profile = {
      ...baseProfile,
      handbook: { status: 'not_started', lesson: 0, completedLessons: [] },
    };
  }

  const commandId = ids.next();
  return {
    ok: true,
    value: {
      commandId,
      ownerId: current.ownerId,
      profileId: current.profileId,
      expectedProfileRevision: current.profileRevision,
      now,
      profile,
      records,
      eventType,
      eventIds: [ids.next(), ...records.map(() => ids.next())],
      outbox: {
        mutationGroupId: ids.next(),
        operationIds: [ids.next(), ...records.map(() => ids.next())],
      },
    },
  };
}

function buildPlanningRecords(
  current: OnboardingState,
  draft: OnboardingDraft,
  now: Instant,
  ids: IdProvider,
): OnboardingApplicationResult<
  Readonly<{ artifacts: OnboardingArtifacts; records: readonly OnboardingRecordMutation[] }>
> {
  if (draft.defaults === null) return { ok: false, message: 'Planning defaults are required.' };
  if (draft.axes.length < current.artifacts.axisIds.length) {
    return { ok: false, message: 'Existing starter Axes can be renamed here but not removed.' };
  }
  if (draft.week.commitments.length < current.artifacts.commitments.length) {
    return { ok: false, message: 'Existing fixed commitments can be edited here but not removed.' };
  }
  const zone = parseIanaTimeZone(draft.defaults.planningTimeZone);
  if (!zone.ok)
    return { ok: false, message: 'Choose a valid IANA time zone.', field: 'planningTimeZone' };
  const records: OnboardingRecordMutation[] = [];
  const axisIds = draft.axes.map((_, index) => current.artifacts.axisIds[index] ?? ids.next());
  draft.axes.forEach((title, index) => {
    const id = axisIds[index];
    if (id !== undefined)
      records.push({
        kind: 'axis',
        id,
        title,
        sortKey: `onboarding-${String(index + 1).padStart(2, '0')}`,
      });
  });
  const artifacts: MutableArtifacts = {
    axisIds,
    commitments: [],
    ...copyOptionalArtifacts(current.artifacts),
  };

  if (draft.outcome !== null) {
    artifacts.outcomeId ??= ids.next();
    const linkedAxis =
      draft.outcome.axisIndex === undefined ? undefined : axisIds[draft.outcome.axisIndex];
    records.push({
      kind: 'outcome',
      id: artifacts.outcomeId,
      ...(linkedAxis === undefined ? {} : { axisId: linkedAxis }),
      title: draft.outcome.title,
      successDefinition: draft.outcome.successDefinition,
      ...(draft.outcome.targetDate === undefined ? {} : { targetDate: draft.outcome.targetDate }),
      sortKey: 'onboarding-01',
    });
  }
  addContextRecords(draft, artifacts, records, ids);

  for (const [index, commitment] of draft.week.commitments.entries()) {
    const pair = current.artifacts.commitments[index] ?? {
      commitmentId: ids.next(),
      timeBlockId: ids.next(),
    };
    const startTime = parseWallTime(commitment.start);
    const endTime = parseWallTime(commitment.end);
    if (!startTime.ok || !endTime.ok)
      return {
        ok: false,
        message: 'One fixed commitment has an invalid local time.',
        field: 'commitments',
      };
    const commitmentZone = parseIanaTimeZone(commitment.timeZone ?? zone.value);
    if (!commitmentZone.ok)
      return {
        ok: false,
        message: 'One fixed commitment has an invalid time zone.',
        field: 'commitments',
      };
    const start = resolveFloatingDateTime({
      date: commitment.date as never,
      wallTime: startTime.value,
      timeZone: commitmentZone.value,
      gapPolicy: 'shift_forward',
      overlapPolicy: 'earlier_offset',
    });
    const end = resolveFloatingDateTime({
      date: commitment.date as never,
      wallTime: endTime.value,
      timeZone: commitmentZone.value,
      gapPolicy: 'shift_forward',
      overlapPolicy: 'earlier_offset',
    });
    if (
      !start.ok ||
      start.value === null ||
      !end.ok ||
      end.value === null ||
      start.value >= end.value
    ) {
      return {
        ok: false,
        message: 'One fixed commitment has an invalid local time.',
        field: 'commitments',
      };
    }
    artifacts.commitments.push(pair);
    records.push({
      kind: 'commitment',
      id: pair.commitmentId,
      title: commitment.title,
      strength: commitment.strength,
    });
    records.push({
      kind: 'time_block',
      id: pair.timeBlockId,
      commitmentId: pair.commitmentId,
      startsAtUtc: start.value,
      endsAtUtc: end.value,
      timeZone: commitmentZone.value,
    });
  }

  // The starter Action's day, week, and focus belong to the person once setup is done (planning Plan,
  // Today). Only a commit that creates the starter Action places it: the first completion, or
  // a rerun after it was permanently deleted (its ids are then new). Any other rerun keeps the
  // recorded ids and sends no placement, focus, or week record, so it never moves, reorders,
  // re-dates, re-adds, or rewrites them, archived ones included.
  const newStarterAction = artifacts.actionId === undefined;
  artifacts.actionId ??= ids.next();
  artifacts.placementId ??= ids.next();
  artifacts.focusId ??= ids.next();
  artifacts.weekSelectionId ??= ids.next();
  const date = currentPlanningDate({ now: () => now }, zone.value);
  const week = createWeekPeriod(date, draft.defaults.weekStart);
  const day = createDayPeriod(date);
  const actionAxis =
    draft.outcome?.axisIndex === undefined ? undefined : axisIds[draft.outcome.axisIndex];
  records.push({
    kind: 'action',
    id: artifacts.actionId,
    ...(actionAxis === undefined ? {} : { axisId: actionAxis }),
    title: draft.week.actionTitle,
    sortKey: 'onboarding-01',
  });
  if (newStarterAction)
    records.push(
      {
        kind: 'placement',
        id: artifacts.placementId,
        actionId: artifacts.actionId,
        localDate: day.date,
        sortKey: 'onboarding-01',
      },
      {
        kind: 'focus',
        id: artifacts.focusId,
        actionId: artifacts.actionId,
        localDate: day.date,
        sortKey: 'onboarding-01',
      },
      {
        kind: 'week_selection',
        id: artifacts.weekSelectionId,
        actionId: artifacts.actionId,
        startDate: week.start,
        endDate: week.end,
        weekStart: week.weekStart,
        sortKey: 'onboarding-01',
      },
    );
  return { ok: true, value: { artifacts, records } };
}

function addContextRecords(
  draft: OnboardingDraft,
  artifacts: MutableArtifacts,
  records: OnboardingRecordMutation[],
  ids: IdProvider,
): void {
  if (draft.context.awakeWindow !== undefined) {
    artifacts.awakeContextId ??= ids.next();
    records.push({
      kind: 'context',
      id: artifacts.awakeContextId,
      category: 'availability',
      contextKey: 'typical_awake_window',
      value: `${draft.context.awakeWindow.start}/${draft.context.awakeWindow.end}`,
      strength: 'unknown',
    });
  }
  if (draft.context.availability !== undefined) {
    artifacts.availabilityContextId ??= ids.next();
    artifacts.availabilityConstraintId ??= ids.next();
    const availability = draft.context.availability;
    records.push({
      kind: 'context',
      id: artifacts.availabilityContextId,
      category: 'availability',
      contextKey: 'regular_availability',
      value: availability.label,
      strength: availability.strength,
    });
    records.push({
      kind: 'constraint',
      id: artifacts.availabilityConstraintId,
      contextId: artifacts.availabilityContextId,
      strength: availability.strength,
      payload: {
        kind: 'availability',
        windows: availability.weekdays.map((weekday) => ({
          weekday,
          start: availability.start,
          end: availability.end,
        })),
      },
    });
  }
  if (draft.context.boundary !== undefined) {
    artifacts.boundaryContextId ??= ids.next();
    records.push({
      kind: 'context',
      id: artifacts.boundaryContextId,
      category: 'boundaries',
      contextKey: 'protected_boundary',
      value: draft.context.boundary.text,
      strength: draft.context.boundary.strength,
    });
  }
}

type MutableArtifacts = {
  axisIds: UUID[];
  outcomeId?: UUID;
  actionId?: UUID;
  placementId?: UUID;
  focusId?: UUID;
  weekSelectionId?: UUID;
  awakeContextId?: UUID;
  availabilityContextId?: UUID;
  availabilityConstraintId?: UUID;
  boundaryContextId?: UUID;
  commitments: { commitmentId: UUID; timeBlockId: UUID }[];
};

function copyOptionalArtifacts(artifacts: OnboardingArtifacts): Partial<MutableArtifacts> {
  return Object.fromEntries(
    Object.entries(artifacts).filter(
      ([key, value]) => key !== 'axisIds' && key !== 'commitments' && value !== undefined,
    ),
  );
}

function profileFromState(state: OnboardingState): OnboardingProfileMutation {
  const defaults = state.draft.defaults;
  if (defaults === null) throw new Error('Initialized onboarding state is missing defaults.');
  return {
    ...(optional(state.draft.identity.preferredName) === undefined
      ? {}
      : { preferredName: optional(state.draft.identity.preferredName) }),
    ...(optional(state.draft.identity.locale) === undefined
      ? {}
      : { localeOverride: optional(state.draft.identity.locale) }),
    planningTimeZone: defaults.planningTimeZone,
    weekStart: defaults.weekStart,
    timeFormat: defaults.timeFormat,
    status: state.status,
    step: state.step,
    completedSteps: state.completedSteps,
    skippedSteps: state.skippedSteps,
    draft: state.draft,
    artifacts: state.artifacts,
    ...(state.defaultsConfirmedAt === undefined
      ? {}
      : { defaultsConfirmedAt: state.defaultsConfirmedAt }),
    ...(state.completedAt === undefined ? {} : { completedAt: state.completedAt }),
    handbook: state.handbook,
  };
}

function nextStep(step: Exclude<OnboardingStep, 'welcome' | 'handbook'>): OnboardingStep {
  const index = ['defaults', 'context', 'axes', 'outcome', 'week'].indexOf(step);
  return (['context', 'axes', 'outcome', 'week', 'handbook'][index] ??
    'handbook') as OnboardingStep;
}

function addStep(
  steps: readonly OnboardingStep[],
  step: OnboardingStep,
): readonly OnboardingStep[] {
  return [...new Set([...steps, step])];
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function validHandbookProgress(lesson: number, completedLessons: readonly number[]): boolean {
  return (
    Number.isInteger(lesson) &&
    lesson >= 0 &&
    lesson <= 4 &&
    completedLessons.every((value) => Number.isInteger(value) && value >= 0 && value <= 3)
  );
}

function validationFailure(
  details: Readonly<Record<string, unknown>> | undefined,
): OnboardingApplicationResult<never> {
  return {
    ok: false,
    message: 'Please check the highlighted setup information.',
    ...(typeof details?.['field'] === 'string' ? { field: details['field'] } : {}),
  };
}

export function browserClock(): Clock {
  return {
    now() {
      const parsed = parseInstant(new Date().toISOString());
      if (!parsed.ok) throw new Error('The system clock did not produce a canonical instant.');
      return parsed.value;
    },
  };
}

export function browserIdProvider(): IdProvider {
  return { next: () => crypto.randomUUID() as UUID };
}
