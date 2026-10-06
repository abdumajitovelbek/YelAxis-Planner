/**
 * Strict runtime checks of Review command input. The whole input is checked
 * before anything is read: types, unexpected fields, limits, the decision matrix with at most one
 * decision per target and slot, at most three focus items and commitments, and text caps. Longer
 * text is refused, never truncated; only blank optional text becomes absent. Nothing here reads the
 * plan: whether targets exist, and whether decisions still apply, is checked inside the command.
 */
import {
  createEntityRef,
  endDayLimits,
  err,
  isAllowedReviewDecision,
  isReviewDecisionKind,
  isReviewType,
  normalizeReviewText,
  ok,
  parseCalendarDate,
  parseReviewDirection,
  parseReviewEnergy,
  parseReviewPeriodKey,
  parseUUID,
  planDayFocus,
  reviewDecisionSlot,
  reviewLimits,
  occurrenceLogicalKey,
  weekdays,
  type DomainResult,
  type EnergyLabel,
  type EntityRef,
  type GeneratedOccurrencePeriod,
  type HorizonPeriod,
  type OwnerId,
  type ReviewDecisionKind,
  type ReviewDirectionDecision,
  type ReviewPeriod,
  type ReviewTargetKind,
  type ReviewType,
  type UUID,
} from '@yelaxis/domain';

import type { OccurrenceTargetInput, PlacementPeriodInput } from './planning-contracts';
import { invalid } from './planning-scheduling-support';
import {
  weekCommitmentKinds,
  type WeekCommitmentKind,
  type WeekCommitmentTarget,
} from './planning-week-commitments';
import type { ReviewItemTargetDocument } from './review-contracts';
import type { EndDayInput, FocusTargetInput } from './today-contracts';
import type { ParsedEndDayInput } from './today-end-day';
import { parseFocusTarget } from './today-focus-plan';

/* ───────────────────────── Parsed shapes ───────────────────────── */

/** A target a review item can name (never a deleted or legacy kind). */
export type ReviewTargetDocument = Exclude<
  ReviewItemTargetDocument,
  { readonly kind: 'routine' | 'commitment' | 'deleted' }
>;

/** One chosen decision, as a review item stores it. */
export interface DesiredReviewItem {
  /** Target and decision slot: a review holds at most one decision per target and slot. */
  readonly key: string;
  readonly target: ReviewTargetDocument;
  readonly decision: ReviewDecisionKind;
  /** `move` only: the chosen Day, Week, or Month, named by its first date. */
  readonly period?: PlacementPeriodInput;
  readonly note?: string;
}

/** An Outcome, Milestone, or Project state decision with the revision the person saw. */
export interface ObjectDecision {
  readonly kind: 'outcome' | 'milestone' | 'project';
  readonly ref: EntityRef<'outcome' | 'milestone' | 'project'>;
  readonly revision: number;
  readonly decision: ReviewDecisionKind;
}

/** End Day choices with a valid shape; `parseEndDayInput` checks what they mean. */
export interface EndDayChoices {
  readonly actions: EndDayInput['actions'];
  readonly occurrences: EndDayInput['occurrences'];
  readonly nextFocus?: readonly FocusTargetInput[];
  readonly carryTo?: string;
}

interface ParsedBase {
  readonly period: ReviewPeriod;
  /** The saved review's revision; absent when the person saw no saved review. */
  readonly revision?: number;
  readonly notes?: string;
}

export type ParsedReviewInput =
  | (ParsedBase & {
      readonly type: 'daily';
      readonly energy?: EnergyLabel;
      readonly endDay: EndDayChoices;
    })
  | (ParsedBase & {
      readonly type: 'weekly';
      /** `continue` or `pause`. */
      readonly projects: readonly ObjectDecision[];
      /** Non-blank notes only. */
      readonly axisNotes: readonly { readonly axisId: UUID; readonly note: string }[];
      /** Omitted leaves the planning Week's commitments unchanged. */
      readonly commitments?: readonly WeekCommitmentTarget[];
      /** Omitted leaves the first day's focus unchanged. */
      readonly firstDayFocus?: readonly FocusTargetInput[];
    })
  | (ParsedBase & {
      readonly type: 'monthly';
      readonly objects: readonly ObjectDecision[];
      /** Absent (or blank) leaves the planning month's theme unchanged. */
      readonly theme?: string;
    })
  | (ParsedBase & {
      readonly type: 'yearly';
      readonly objects: readonly ObjectDecision[];
      readonly direction?: ReviewDirectionDecision;
    });

/* ───────────────────────── Errors ───────────────────────── */

const malformed = (): DomainResult<never> =>
  invalid('review_input', 'This review request is not valid. Refresh and try again.');

const decisionUnavailable = (): DomainResult<never> =>
  invalid('review_decision', 'This decision is not available here.');

const duplicateDecision = (): DomainResult<never> =>
  invalid('review_duplicate', 'Each item can have one decision of each kind in a review.');

const tooManyItems = (): DomainResult<never> =>
  invalid('review_limit', 'A review holds up to 400 decisions.');

const tooManyCommitments = (): DomainResult<never> =>
  invalid('review_commitment_limit', 'Choose up to three commitments for the week.');

/* ───────────────────────── Shape helpers ───────────────────────── */

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A plain object whose own keys are all allowed, or null. */
function fields(value: unknown, allowed: readonly string[]): Fields | null {
  if (!isRecord(value)) return null;
  return Object.keys(value).every((key) => allowed.includes(key)) ? value : null;
}

/** An array of at most `max` entries: a longer one is refused before it is read. */
function list(value: unknown, max: number): DomainResult<readonly unknown[]> {
  if (!Array.isArray(value)) return malformed();
  return value.length > max ? tooManyItems() : ok(value as readonly unknown[]);
}

const isRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

const isDate = (value: unknown): boolean =>
  typeof value === 'string' && parseCalendarDate(value).ok;

function uuid(value: unknown): DomainResult<UUID> {
  return parseUUID(typeof value === 'string' ? value : '');
}

/** A generated occurrence period with exactly its own fields. */
function isOccurrencePeriod(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'date')
    return fields(value, ['kind', 'date']) !== null && isDate(value['date']);
  const count = value['targetCount'];
  return (
    value['kind'] === 'week' &&
    fields(value, ['kind', 'start', 'end', 'weekStart', 'targetCount']) !== null &&
    isDate(value['start']) &&
    isDate(value['end']) &&
    weekdays.some((weekday) => weekday === value['weekStart']) &&
    typeof count === 'number' &&
    Number.isSafeInteger(count) &&
    count > 0
  );
}

/** An occurrence named by its Routine, generation, and logical period (and revision). */
function isOccurrenceInput(value: unknown): value is OccurrenceTargetInput {
  const occurrence = fields(value, ['routineId', 'generation', 'period', 'revision']);
  if (occurrence === null) return false;
  const generation = occurrence['generation'];
  const revision = occurrence['revision'];
  return (
    typeof occurrence['routineId'] === 'string' &&
    typeof generation === 'number' &&
    Number.isSafeInteger(generation) &&
    generation >= 1 &&
    (revision === undefined || isRevision(revision)) &&
    isOccurrencePeriod(occurrence['period'])
  );
}

function isFocusTargetInput(value: unknown): value is FocusTargetInput {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'action')
    return fields(value, ['kind', 'actionId']) !== null && typeof value['actionId'] === 'string';
  return (
    value['kind'] === 'routine_occurrence' &&
    fields(value, ['kind', 'occurrence']) !== null &&
    isOccurrenceInput(value['occurrence'])
  );
}

/** Focus targets in order: at most three, each once (the rules of choosing focus anywhere). */
function parseFocusList(value: unknown, ownerId: OwnerId): DomainResult<FocusTargetInput[]> {
  const entries = list(value, reviewLimits.items);
  if (!entries.ok) return entries;
  const targets: FocusTargetInput[] = [];
  const keys = [];
  for (const entry of entries.value) {
    if (!isFocusTargetInput(entry)) return malformed();
    const parsed = parseFocusTarget(ownerId, entry);
    if (!parsed.ok) return parsed;
    targets.push(entry);
    keys.push(parsed.value.key);
  }
  const shape = planDayFocus([], keys);
  return shape.ok ? ok(targets) : shape;
}

/* ───────────────────────── Sections ───────────────────────── */

function parseObjectDecisions(
  value: unknown,
  type: ReviewType,
  kind: ObjectDecision['kind'],
  ownerId: OwnerId,
): DomainResult<ObjectDecision[]> {
  const entries = list(value, reviewLimits.items);
  if (!entries.ok) return entries;
  const decisions: ObjectDecision[] = [];
  for (const entry of entries.value) {
    const decision = fields(entry, ['id', 'revision', 'decision']);
    if (decision === null) return malformed();
    const id = uuid(decision['id']);
    if (!id.ok) return id;
    const revision = decision['revision'];
    if (!isRevision(revision)) return invalid('revision');
    const choice = decision['decision'];
    if (
      !isReviewDecisionKind(choice) ||
      reviewDecisionSlot(choice) !== 'state' ||
      !isAllowedReviewDecision(type, kind, choice)
    )
      return decisionUnavailable();
    decisions.push({
      kind,
      ref: createEntityRef(kind, id.value, ownerId),
      revision,
      decision: choice,
    });
  }
  return ok(decisions);
}

function parseEndDayChoices(value: unknown): DomainResult<EndDayChoices> {
  const endDay = fields(value, ['actions', 'occurrences', 'nextFocus', 'carryTo']);
  if (endDay === null) return malformed();
  const actions = list(endDay['actions'], reviewLimits.items);
  if (!actions.ok) return actions;
  const occurrences = list(endDay['occurrences'], reviewLimits.items);
  if (!occurrences.ok) return occurrences;
  if (
    actions.value.length > endDayLimits.actions ||
    occurrences.value.length > endDayLimits.occurrences
  )
    return invalid(
      'end_day_limit',
      'End day applies up to 200 Actions and 100 routine occurrences at a time.',
    );
  for (const entry of actions.value) {
    const action = fields(entry, ['actionId', 'revision', 'decision']);
    if (action === null || typeof action['actionId'] !== 'string') return malformed();
    const decision = fields(action['decision'], ['kind', 'period']);
    if (decision === null) return malformed();
    if (decision['kind'] === 'move') {
      if (fields(decision['period'], ['kind', 'date']) === null) return malformed();
    } else if ('period' in decision) return malformed();
  }
  for (const entry of occurrences.value) {
    const occurrence = fields(entry, ['occurrence', 'decision']);
    if (
      occurrence === null ||
      !isOccurrenceInput(occurrence['occurrence']) ||
      fields(occurrence['decision'], ['kind']) === null
    )
      return malformed();
  }
  const nextFocus = endDay['nextFocus'];
  if (nextFocus !== undefined) {
    const focus = list(nextFocus, reviewLimits.items);
    if (!focus.ok) return focus;
    if (!focus.value.every(isFocusTargetInput)) return malformed();
  }
  const carryTo = endDay['carryTo'];
  if (carryTo !== undefined && typeof carryTo !== 'string') return malformed();
  return ok(endDay as unknown as EndDayChoices);
}

function parseCommitments(value: unknown): DomainResult<WeekCommitmentTarget[]> {
  if (!Array.isArray(value)) return malformed();
  if (value.length > reviewLimits.commitments) return tooManyCommitments();
  const targets: WeekCommitmentTarget[] = [];
  for (const entry of value as readonly unknown[]) {
    const target = fields(entry, ['kind', 'id']);
    const kind = weekCommitmentKinds.find((candidate) => candidate === target?.['kind']);
    if (target === null || kind === undefined) return malformed();
    const id = uuid(target['id']);
    if (!id.ok) return id;
    targets.push({ kind, id: id.value });
  }
  return ok(targets);
}

function parseAxisNotes(value: unknown): DomainResult<{ axisId: UUID; note: string }[]> {
  const entries = list(value, reviewLimits.items);
  if (!entries.ok) return entries;
  const notes: { axisId: UUID; note: string }[] = [];
  for (const entry of entries.value) {
    const axisNote = fields(entry, ['axisId', 'note']);
    if (axisNote === null || typeof axisNote['note'] !== 'string') return malformed();
    const axisId = uuid(axisNote['axisId']);
    if (!axisId.ok) return axisId;
    const note = normalizeReviewText(axisNote['note'], reviewLimits.itemNote, 'note');
    if (!note.ok) return note;
    if (note.value !== undefined) notes.push({ axisId: axisId.value, note: note.value });
  }
  return ok(notes);
}

/* ───────────────────────── Inputs ───────────────────────── */

const baseKeys = ['type', 'periodKey', 'revision', 'notes'] as const;
const typeKeys: Readonly<Record<ReviewType, readonly string[]>> = {
  daily: [...baseKeys, 'energy', 'endDay'],
  weekly: [...baseKeys, 'projects', 'axisNotes', 'commitments', 'firstDayFocus'],
  monthly: [...baseKeys, 'outcomes', 'milestones', 'projects', 'theme'],
  yearly: [...baseKeys, 'outcomes', 'direction'],
};

/** The type, period, and revision every Review command names. */
function parseIdentity(
  input: Fields,
): DomainResult<{ readonly type: ReviewType; readonly base: ParsedBase }> {
  const type = input['type'];
  if (!isReviewType(type))
    return err({
      code: 'invalid_value',
      message: 'Choose a daily, weekly, monthly, or yearly review.',
      details: { reason: 'review_type' },
    });
  const period = parseReviewPeriodKey(type, input['periodKey']);
  if (!period.ok) return period;
  const revision = input['revision'];
  if (revision !== undefined && !isRevision(revision)) return invalid('revision');
  return ok({
    type,
    base: { period: period.value, ...(revision === undefined ? {} : { revision }) },
  });
}

/** Validate a Save or Finish input completely; nothing is read. */
export function parseReviewInput(
  value: unknown,
  ownerId: OwnerId,
): DomainResult<ParsedReviewInput> {
  if (!isRecord(value)) return malformed();
  const identity = parseIdentity(value);
  if (!identity.ok) return identity;
  const { type } = identity.value;
  const input = fields(value, typeKeys[type]);
  if (input === null) return malformed();
  const notes = normalizeReviewText(input['notes'], reviewLimits.notes, 'notes');
  if (!notes.ok) return notes;
  const base: ParsedBase = {
    ...identity.value.base,
    ...(notes.value === undefined ? {} : { notes: notes.value }),
  };

  switch (type) {
    case 'daily': {
      const energy = parseReviewEnergy(input['energy']);
      if (!energy.ok) return energy;
      const endDay = parseEndDayChoices(input['endDay']);
      if (!endDay.ok) return endDay;
      return ok({
        ...base,
        type,
        ...(energy.value === undefined ? {} : { energy: energy.value }),
        endDay: endDay.value,
      });
    }
    case 'weekly': {
      const projects = parseObjectDecisions(input['projects'], type, 'project', ownerId);
      if (!projects.ok) return projects;
      const axisNotes = parseAxisNotes(input['axisNotes']);
      if (!axisNotes.ok) return axisNotes;
      const rawCommitments = input['commitments'];
      const commitments = rawCommitments === undefined ? null : parseCommitments(rawCommitments);
      if (commitments !== null && !commitments.ok) return commitments;
      const rawFocus = input['firstDayFocus'];
      const firstDayFocus = rawFocus === undefined ? null : parseFocusList(rawFocus, ownerId);
      if (firstDayFocus !== null && !firstDayFocus.ok) return firstDayFocus;
      return ok({
        ...base,
        type,
        projects: projects.value,
        axisNotes: axisNotes.value,
        ...(commitments === null ? {} : { commitments: commitments.value }),
        ...(firstDayFocus === null ? {} : { firstDayFocus: firstDayFocus.value }),
      });
    }
    case 'monthly': {
      const objects: ObjectDecision[] = [];
      for (const [field, kind] of [
        ['outcomes', 'outcome'],
        ['milestones', 'milestone'],
        ['projects', 'project'],
      ] as const) {
        const decisions = parseObjectDecisions(input[field], type, kind, ownerId);
        if (!decisions.ok) return decisions;
        objects.push(...decisions.value);
      }
      const theme = normalizeReviewText(input['theme'], reviewLimits.themeText, 'theme');
      if (!theme.ok) return theme;
      return ok({
        ...base,
        type,
        objects,
        ...(theme.value === undefined ? {} : { theme: theme.value }),
      });
    }
    case 'yearly': {
      const objects = parseObjectDecisions(input['outcomes'], type, 'outcome', ownerId);
      if (!objects.ok) return objects;
      const direction = parseReviewDirection(input['direction']);
      if (!direction.ok) return direction;
      return ok({
        ...base,
        type,
        objects: objects.value,
        ...(direction.value === undefined ? {} : { direction: direction.value }),
      });
    }
  }
}

/** Validate a Skip input: exactly the type, the period key, and an optional revision. */
export function parseSkipInput(
  value: unknown,
): DomainResult<{ readonly type: ReviewType; readonly base: ParsedBase }> {
  const input = fields(value, ['type', 'periodKey', 'revision']);
  return input === null ? malformed() : parseIdentity(input);
}

/* ───────────────────────── Review items ───────────────────────── */

/** Stable identity of a stored target, or null for a deleted or legacy one. */
export function reviewTargetKey(target: ReviewItemTargetDocument): string | null {
  switch (target.kind) {
    case 'axis':
      return `axis:${target.axisId}`;
    case 'outcome':
      return `outcome:${target.outcomeId}`;
    case 'milestone':
      return `milestone:${target.milestoneId}`;
    case 'project':
      return `project:${target.projectId}`;
    case 'action':
      return `action:${target.actionId}`;
    case 'routine_occurrence':
      return `routine_occurrence:${occurrenceLogicalKey(target.routineId, target.generation, target.period)}`;
    case 'routine':
    case 'commitment':
    case 'deleted':
      return null;
  }
}

/** The record whose existence a review item's target needs (a Routine for an occurrence). */
export function reviewTargetRef(ownerId: OwnerId, target: ReviewTargetDocument): EntityRef {
  switch (target.kind) {
    case 'axis':
      return createEntityRef('axis', target.axisId, ownerId);
    case 'outcome':
      return createEntityRef('outcome', target.outcomeId, ownerId);
    case 'milestone':
      return createEntityRef('milestone', target.milestoneId, ownerId);
    case 'project':
      return createEntityRef('project', target.projectId, ownerId);
    case 'action':
      return createEntityRef('action', target.actionId, ownerId);
    case 'routine_occurrence':
      return createEntityRef('routine', target.routineId, ownerId);
  }
}

const targetKindOf = (target: ReviewTargetDocument): ReviewTargetKind => target.kind;

/** A clean copy of a generated occurrence period (no extra fields). */
function occurrencePeriod(period: GeneratedOccurrencePeriod): GeneratedOccurrencePeriod {
  return period.kind === 'date'
    ? { kind: 'date', date: period.date }
    : {
        kind: 'week',
        start: period.start,
        end: period.end,
        weekStart: period.weekStart,
        targetCount: period.targetCount,
      };
}

function occurrenceTarget(occurrence: OccurrenceTargetInput): DomainResult<ReviewTargetDocument> {
  const routineId = uuid(occurrence.routineId);
  if (!routineId.ok) return routineId;
  return ok({
    kind: 'routine_occurrence',
    routineId: routineId.value,
    generation: occurrence.generation,
    period: occurrencePeriod(occurrence.period),
  });
}

function focusTarget(
  target: FocusTargetInput,
  ownerId: OwnerId,
): DomainResult<ReviewTargetDocument> {
  const parsed = parseFocusTarget(ownerId, target);
  if (!parsed.ok) return parsed;
  return parsed.value.kind === 'action'
    ? ok({ kind: 'action', actionId: parsed.value.ref.id })
    : occurrenceTarget(parsed.value.occurrence);
}

/** The first date that names a period, as a placement period input stores it. */
function periodInput(period: HorizonPeriod): PlacementPeriodInput {
  switch (period.kind) {
    case 'day':
      return { kind: 'day', date: period.date };
    case 'week':
      return { kind: 'week', date: period.start };
    case 'month':
      return { kind: 'month', date: `${period.month}-01` };
    case 'year':
      return { kind: 'year', date: `${period.year}-01-01` };
  }
}

interface ItemChoice {
  readonly target: ReviewTargetDocument;
  readonly decision: ReviewDecisionKind;
  readonly period?: PlacementPeriodInput;
  readonly note?: string;
}

/**
 * The chosen decisions in the person's order, each allowed for the review type, at
 * most one per target and slot, and at most 400 in all.
 */
function desiredItems(
  type: ReviewType,
  choices: readonly ItemChoice[],
): DomainResult<DesiredReviewItem[]> {
  if (choices.length > reviewLimits.items) return tooManyItems();
  const seen = new Set<string>();
  const items: DesiredReviewItem[] = [];
  for (const choice of choices) {
    if (!isAllowedReviewDecision(type, targetKindOf(choice.target), choice.decision))
      return decisionUnavailable();
    const key = `${reviewTargetKey(choice.target) ?? ''}|${reviewDecisionSlot(choice.decision)}`;
    if (seen.has(key)) return duplicateDecision();
    seen.add(key);
    items.push({ key, ...choice });
  }
  return ok(items);
}

const objectTarget = (decision: ObjectDecision): ReviewTargetDocument => {
  switch (decision.kind) {
    case 'outcome':
      return { kind: 'outcome', outcomeId: decision.ref.id };
    case 'milestone':
      return { kind: 'milestone', milestoneId: decision.ref.id };
    case 'project':
      return { kind: 'project', projectId: decision.ref.id };
  }
};

const commitmentTarget = (target: WeekCommitmentTarget): ReviewTargetDocument => {
  const kind: WeekCommitmentKind = target.kind;
  switch (kind) {
    case 'action':
      return { kind: 'action', actionId: target.id };
    case 'project':
      return { kind: 'project', projectId: target.id };
    case 'milestone':
      return { kind: 'milestone', milestoneId: target.id };
  }
};

/**
 * The review items a daily review records: each End Day choice (a move keeps its
 * period), then the next day's focus in order.
 */
export function dailyReviewItems(
  endDay: ParsedEndDayInput,
  ownerId: OwnerId,
): DomainResult<DesiredReviewItem[]> {
  const choices: ItemChoice[] = [];
  for (const item of endDay.actions)
    choices.push({
      target: { kind: 'action', actionId: item.ref.id },
      decision: item.decision.kind,
      ...(item.decision.kind === 'move' ? { period: periodInput(item.decision.period) } : {}),
    });
  for (const item of endDay.occurrences) {
    const target = occurrenceTarget(item.occurrence);
    if (!target.ok) return target;
    choices.push({ target: target.value, decision: item.decision });
  }
  for (const focus of endDay.nextFocus ?? []) {
    const target = focusTarget(focus, ownerId);
    if (!target.ok) return target;
    choices.push({ target: target.value, decision: 'focus' });
  }
  return desiredItems('daily', choices);
}

/** The review items of a weekly, monthly, or yearly review, in the person's order. */
export function periodReviewItems(
  input: Exclude<ParsedReviewInput, { readonly type: 'daily' }>,
  ownerId: OwnerId,
): DomainResult<DesiredReviewItem[]> {
  const choices: ItemChoice[] = [];
  switch (input.type) {
    case 'weekly': {
      for (const decision of input.projects)
        choices.push({ target: objectTarget(decision), decision: decision.decision });
      for (const axisNote of input.axisNotes)
        choices.push({
          target: { kind: 'axis', axisId: axisNote.axisId },
          decision: 'note',
          note: axisNote.note,
        });
      for (const commitment of input.commitments ?? [])
        choices.push({ target: commitmentTarget(commitment), decision: 'commit' });
      for (const focus of input.firstDayFocus ?? []) {
        const target = focusTarget(focus, ownerId);
        if (!target.ok) return target;
        choices.push({ target: target.value, decision: 'focus' });
      }
      break;
    }
    case 'monthly':
    case 'yearly':
      for (const decision of input.objects)
        choices.push({ target: objectTarget(decision), decision: decision.decision });
      break;
  }
  return desiredItems(input.type, choices);
}
