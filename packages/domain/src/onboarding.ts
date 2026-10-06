import { err, ok, type DomainResult } from './contracts.js';
import { parseCalendarDate, parseIanaTimeZone, parseWallTime, type Weekday } from './time.js';
import { isOnboardingDraftInput } from './onboarding-input.js';

export const onboardingSteps = [
  'welcome',
  'defaults',
  'context',
  'axes',
  'outcome',
  'week',
  'handbook',
] as const;

export type OnboardingStep = (typeof onboardingSteps)[number];
export type OnboardingStatus = 'not_started' | 'in_progress' | 'completed';
export type HandbookStatus = 'not_started' | 'in_progress' | 'skipped' | 'completed';
export type OnboardingConstraintStrength = 'hard' | 'soft' | 'unknown';

export type OnboardingDefaults = Readonly<{
  planningTimeZone: string;
  weekStart: Weekday;
  timeFormat: '12_hour' | '24_hour';
  locale: string;
}>;

export type OnboardingCommitmentDraft = Readonly<{
  title: string;
  date: string;
  start: string;
  end: string;
  strength: 'hard' | 'soft';
  confirmed: boolean;
  /** Retained for an existing fixed commitment so a Profile-zone edit cannot move its instant. */
  timeZone?: string;
}>;

export type OnboardingDraft = Readonly<{
  identity: Readonly<{ preferredName: string; locale: string }>;
  defaults: OnboardingDefaults | null;
  context: Readonly<{
    awakeWindow?: Readonly<{ start: string; end: string }>;
    availability?: Readonly<{
      label: string;
      weekdays: readonly Weekday[];
      start: string;
      end: string;
      strength: OnboardingConstraintStrength;
    }>;
    boundary?: Readonly<{ text: string; strength: OnboardingConstraintStrength }>;
  }>;
  axes: readonly string[];
  outcome: Readonly<{
    title: string;
    successDefinition: string;
    axisIndex?: number;
    targetDate?: string;
  }> | null;
  week: Readonly<{
    commitments: readonly OnboardingCommitmentDraft[];
    actionTitle: string;
  }>;
}>;

export function emptyOnboardingDraft(): OnboardingDraft {
  return {
    identity: { preferredName: '', locale: '' },
    defaults: null,
    context: {},
    axes: [],
    outcome: null,
    week: { commitments: [], actionTitle: '' },
  };
}

const weekDays = new Set<Weekday>([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);
const constraintStrengths = new Set<OnboardingConstraintStrength>(['hard', 'soft', 'unknown']);

const invalid = (reason: string, field?: string): DomainResult<never> =>
  err({
    code: 'invalid_value',
    message: 'Please check the onboarding information and try again.',
    details: field === undefined ? { reason } : { reason, field },
  });

function trimRequired(value: string, maximum: number, field: string): DomainResult<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return invalid('required', field);
  if (trimmed.length > maximum) return invalid('too_long', field);
  return ok(trimmed);
}

function trimOptional(value: string, maximum: number, field: string): DomainResult<string> {
  const trimmed = value.trim();
  if (trimmed.length > maximum) return invalid('too_long', field);
  return ok(trimmed);
}

function validLocale(value: string): boolean {
  return (
    value.length >= 2 && value.length <= 64 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value)
  );
}

function validateDefaults(defaults: OnboardingDefaults | null): DomainResult<OnboardingDefaults> {
  if (defaults === null) return invalid('required', 'defaults');
  const zone = parseIanaTimeZone(defaults.planningTimeZone);
  if (!zone.ok) return invalid('invalid_time_zone', 'planningTimeZone');
  if (!weekDays.has(defaults.weekStart)) return invalid('invalid_week_start', 'weekStart');
  if (defaults.timeFormat !== '12_hour' && defaults.timeFormat !== '24_hour') {
    return invalid('invalid_time_format', 'timeFormat');
  }
  const locale = defaults.locale.trim();
  if (!validLocale(locale)) return invalid('invalid_locale', 'locale');
  return ok({ ...defaults, planningTimeZone: zone.value, locale });
}

function validateWindow(start: string, end: string, field: string): DomainResult<void> {
  if (!parseWallTime(start).ok || !parseWallTime(end).ok || start >= end) {
    return invalid('invalid_wall_time_window', field);
  }
  return ok(undefined);
}

export function validateOnboardingStep(
  step: OnboardingStep,
  candidate: OnboardingDraft,
): DomainResult<OnboardingDraft> {
  if (!onboardingSteps.includes(step) || !isOnboardingDraftInput(candidate))
    return invalid('input_shape');
  const preferredName = trimOptional(candidate.identity.preferredName, 80, 'preferredName');
  if (!preferredName.ok) return preferredName;
  const identityLocale = candidate.identity.locale.trim();
  if (identityLocale.length > 0 && !validLocale(identityLocale)) {
    return invalid('invalid_locale', 'identityLocale');
  }

  let draft: OnboardingDraft = {
    ...candidate,
    identity: { preferredName: preferredName.value, locale: identityLocale },
  };

  if (step === 'welcome') return ok(draft);

  const defaults = validateDefaults(draft.defaults);
  if (!defaults.ok) return defaults;
  draft = { ...draft, defaults: defaults.value };
  if (step === 'defaults') return ok(draft);

  const context = draft.context;
  if (context.awakeWindow !== undefined) {
    const window = validateWindow(
      context.awakeWindow.start,
      context.awakeWindow.end,
      'awakeWindow',
    );
    if (!window.ok) return window;
  }
  if (context.availability !== undefined) {
    const label = trimRequired(context.availability.label, 80, 'availabilityLabel');
    if (!label.ok) return label;
    if (
      context.availability.weekdays.length === 0 ||
      new Set(context.availability.weekdays).size !== context.availability.weekdays.length ||
      context.availability.weekdays.some((weekday) => !weekDays.has(weekday))
    ) {
      return invalid('invalid_weekdays', 'availabilityWeekdays');
    }
    const window = validateWindow(
      context.availability.start,
      context.availability.end,
      'availabilityWindow',
    );
    if (!window.ok) return window;
    if (!constraintStrengths.has(context.availability.strength)) {
      return invalid('invalid_constraint_strength', 'availabilityStrength');
    }
    draft = {
      ...draft,
      context: { ...context, availability: { ...context.availability, label: label.value } },
    };
  }
  if (context.boundary !== undefined) {
    const text = trimRequired(context.boundary.text, 300, 'boundary');
    if (!text.ok) return text;
    if (!constraintStrengths.has(context.boundary.strength)) {
      return invalid('invalid_constraint_strength', 'boundaryStrength');
    }
    draft = {
      ...draft,
      context: { ...draft.context, boundary: { ...context.boundary, text: text.value } },
    };
  }
  if (step === 'context') return ok(draft);

  if (draft.axes.length > 3) return invalid('onboarding_axis_limit', 'axes');
  const axes: string[] = [];
  const normalizedAxes = new Set<string>();
  for (const name of draft.axes) {
    const parsed = trimRequired(name, 80, 'axes');
    if (!parsed.ok) return parsed;
    const normalized = parsed.value.toLocaleLowerCase('en-US');
    if (normalizedAxes.has(normalized)) return invalid('duplicate_axis', 'axes');
    normalizedAxes.add(normalized);
    axes.push(parsed.value);
  }
  draft = { ...draft, axes };
  if (step === 'axes') return ok(draft);

  if (draft.outcome !== null) {
    const title = trimRequired(draft.outcome.title, 120, 'outcomeTitle');
    if (!title.ok) return title;
    const success = trimRequired(draft.outcome.successDefinition, 500, 'successDefinition');
    if (!success.ok) return success;
    if (
      draft.outcome.axisIndex !== undefined &&
      (!Number.isInteger(draft.outcome.axisIndex) ||
        draft.outcome.axisIndex < 0 ||
        draft.outcome.axisIndex >= draft.axes.length)
    ) {
      return invalid('invalid_axis_link', 'outcomeAxis');
    }
    if (draft.outcome.targetDate !== undefined && !parseCalendarDate(draft.outcome.targetDate).ok) {
      return invalid('invalid_target_date', 'outcomeTargetDate');
    }
    draft = {
      ...draft,
      outcome: { ...draft.outcome, title: title.value, successDefinition: success.value },
    };
  }
  if (step === 'outcome') return ok(draft);

  if (draft.week.commitments.length > 3) {
    return invalid('onboarding_commitment_limit', 'commitments');
  }
  const commitments: OnboardingCommitmentDraft[] = [];
  for (const commitment of draft.week.commitments) {
    const title = trimRequired(commitment.title, 120, 'commitmentTitle');
    if (!title.ok) return title;
    if (!parseCalendarDate(commitment.date).ok) {
      return invalid('invalid_commitment_date', 'commitmentDate');
    }
    const window = validateWindow(commitment.start, commitment.end, 'commitmentWindow');
    if (!window.ok) return window;
    if (commitment.strength !== 'hard' && commitment.strength !== 'soft') {
      return invalid('invalid_commitment_strength', 'commitmentStrength');
    }
    if (commitment.timeZone !== undefined && !parseIanaTimeZone(commitment.timeZone).ok) {
      return invalid('invalid_time_zone', 'commitmentTimeZone');
    }
    if (!commitment.confirmed)
      return invalid('fixed_commitment_not_confirmed', 'commitmentConfirmed');
    commitments.push({ ...commitment, title: title.value });
  }
  const actionTitle = trimRequired(draft.week.actionTitle, 200, 'actionTitle');
  if (!actionTitle.ok) return actionTitle;
  draft = { ...draft, week: { commitments, actionTitle: actionTitle.value } };
  return ok(draft);
}

export const validateOnboardingDraft = (
  candidate: OnboardingDraft,
): DomainResult<OnboardingDraft> => validateOnboardingStep('week', candidate);
