/**
 * Review Finish: save the final choices, apply every decision, and complete the
 * review, in one `executeCommand` transaction.
 *
 * Every decision goes through the planner the normal command uses, so a review adds no parallel
 * mutation path: End Day's planner for the daily review (with the next
 * day's focus), the Week-commitment and focus planners for the weekly review, the alignment transition
 * and archive rules for Outcome, Milestone, and Project decisions, and the planning theme and direction
 * rules. Every target is read again with its expected revision; a stale or changed plan refuses the
 * whole command without partial writes ("Review it again"). Events keep the normal per-record types
 * with `{ operation }` payloads, and one grouped `planning.restore_v1` undo reverses the plan and the
 * review together. Finishing a completed review is refused, so no decision is applied twice.
 */
import {
  createEntityRef,
  ok,
  planReviewFinish,
  reviewObjectState,
  reviewPlanningPeriod,
  type AlignmentState,
  type CalendarDate,
  type CommandContext,
  type CommandId,
  type DomainResult,
  type Instant,
  type MonthKey,
  type WeekPeriod,
  type YearKey,
} from '@yelaxis/domain';

import { archiveEventType, planAlignmentArchive } from './alignment-lifecycle';
import { transitionEventType, transitionedDocument } from './alignment-objects';
import type {
  ApplicationResult,
  CanonicalRecordState,
  CommandReceipt,
  ExpectedRevision,
} from './contracts';
import type { YearDirectionDocument } from './planning-contracts';
import { updateFrom } from './planning-kit';
import { changed, expectedOf, invalid, isArchivedDocument } from './planning-scheduling-support';
import {
  findActiveDirection,
  findActiveTheme,
  monthThemeText,
  planMonthTheme,
  planYearDirection,
  themeEventTypes,
  yearDirectionText,
} from './planning-themes';
import {
  planWeekCommitmentMutations,
  readWeekCommitments,
  type WeekCommitmentRecords,
  type WeekCommitmentTarget,
} from './planning-week-commitments';
import type { PlanningRecordReader } from './ports';
import {
  checkTargets,
  createChangeSet,
  currentReview,
  prepareReview,
  reviewChanged,
  reviewStatusOf,
  writeReview,
  type ChangeSet,
  type PreparedReview,
} from './review-commands';
import type { ObjectDecision } from './review-input';
import { reviewEventTypes, weekOf, type ReviewKit, type ReviewSession } from './review-kit';
import type { FocusTargetInput } from './today-contracts';
import { planEndDayMutations, prepareEndDay, type PreparedEndDay } from './today-end-day';
import {
  planFocusMutations,
  prepareDayFocusChange,
  type DayFocusRecords,
} from './today-focus-plan';
import type { TodayCommandPlan } from './today-kit';

/* ───────────────────────── Prepared decisions ───────────────────────── */

type PreparedDirection =
  | {
      readonly choice: 'continue';
      /** The reviewed year's direction, which is copied. */
      readonly reviewed: CanonicalRecordState | null;
      readonly existing: CanonicalRecordState | null;
    }
  | {
      readonly choice: 'new';
      readonly text: string;
      readonly existing: CanonicalRecordState | null;
    };

/** What Finish applies, with every record read before the command. */
type PreparedDecisions =
  | { readonly type: 'daily'; readonly endDay: PreparedEndDay }
  | {
      readonly type: 'weekly';
      /** `pause` is applied; `continue` is recorded only. */
      readonly projects: readonly ObjectDecision[];
      /** The planning Week (`reviewPlanningPeriod`). */
      readonly week: WeekPeriod;
      readonly commitments: {
        readonly desired: readonly WeekCommitmentTarget[];
        readonly current: WeekCommitmentRecords;
      } | null;
      readonly firstDay: {
        /** The planning Week's first day, or today when that day has passed. */
        readonly date: CalendarDate;
        readonly desired: readonly FocusTargetInput[];
        readonly current: DayFocusRecords;
      } | null;
    }
  | {
      readonly type: 'monthly';
      readonly objects: readonly ObjectDecision[];
      readonly theme: {
        readonly month: MonthKey;
        readonly text: string;
        readonly existing: CanonicalRecordState | null;
      } | null;
    }
  | {
      readonly type: 'yearly';
      readonly objects: readonly ObjectDecision[];
      /** Absent for no direction decision and for `outdated`, which changes no plan record. */
      readonly direction: (PreparedDirection & { readonly year: YearKey }) | null;
    };

interface PreparedFinish extends PreparedReview {
  readonly decisions: PreparedDecisions;
  /** The saved review and its items, every decided target, and every planner's records. */
  readonly expected: readonly ExpectedRevision[];
}

const directionMissing = (): DomainResult<never> =>
  invalid(
    'direction_missing',
    'There is no direction to continue. Write a new one, or choose another option.',
  );

/** The first day of the planning Week that focus can still be chosen for. */
const firstFocusDay = (week: WeekPeriod, today: CalendarDate): CalendarDate =>
  week.start < today ? today : week.start;

/**
 * Check the input, read the saved review, and read every record the decisions change, so each one
 * is expected at the revision the person saw (object decisions) or read here (planner records).
 */
async function prepareFinish(
  kit: ReviewKit,
  session: ReviewSession,
  raw: unknown,
): Promise<DomainResult<PreparedFinish>> {
  const prepared = await prepareReview(kit, session, raw, 'finish');
  if (!prepared.ok) return prepared;
  const { ownerId, profile, today } = session;
  const { input } = prepared.value;
  const planning = reviewPlanningPeriod(input.period, today, profile.weekStart);
  if (!planning.ok) return planning;
  const expected: ExpectedRevision[] = [...prepared.value.saved.expected];
  const expectDecisions = (decisions: readonly ObjectDecision[]): void => {
    for (const decision of decisions)
      expected.push({ ref: decision.ref, revision: decision.revision });
  };

  let decisions: PreparedDecisions;
  switch (input.type) {
    case 'daily': {
      const endDay = prepared.value.endDay;
      if (endDay === undefined) return reviewChanged();
      const read = await prepareEndDay(kit, session, endDay);
      // An Action that no longer exists: the plan changed since the review was read.
      if (!read.ok) return changed('target_missing');
      expected.push(...read.value.expected);
      decisions = { type: 'daily', endDay: read.value };
      break;
    }
    case 'weekly': {
      expectDecisions(input.projects);
      const week = weekOf(planning.value);
      let commitments: Extract<PreparedDecisions, { type: 'weekly' }>['commitments'] = null;
      if (input.commitments !== undefined) {
        const current = await readWeekCommitments(kit.queries, ownerId, week);
        if (current.records.length !== current.rows.length) return changed('commitments_changed');
        expected.push(...current.expected);
        commitments = { desired: input.commitments, current };
      }
      let firstDay: Extract<PreparedDecisions, { type: 'weekly' }>['firstDay'] = null;
      if (input.firstDayFocus !== undefined) {
        const date = firstFocusDay(week, today);
        const current = await prepareDayFocusChange(
          kit,
          { ownerId, profileId: profile.profileId, today },
          date,
        );
        if (!current.ok) return current;
        expected.push(...current.value.expected);
        firstDay = { date, desired: input.firstDayFocus, current: current.value };
      }
      decisions = { type: 'weekly', projects: input.projects, week, commitments, firstDay };
      break;
    }
    case 'monthly': {
      expectDecisions(input.objects);
      const month = planning.value.key as MonthKey;
      let theme: Extract<PreparedDecisions, { type: 'monthly' }>['theme'] = null;
      if (input.theme !== undefined) {
        const existing = await findActiveTheme(kit.queries, ownerId, month);
        expected.push(...expectedOf(existing));
        theme = { month, text: input.theme, existing };
      }
      decisions = { type: 'monthly', objects: input.objects, theme };
      break;
    }
    case 'yearly': {
      expectDecisions(input.objects);
      const year = planning.value.key as YearKey;
      const choice = input.direction?.choice;
      let direction: Extract<PreparedDecisions, { type: 'yearly' }>['direction'] = null;
      if (choice === 'continue') {
        const reviewed = await findActiveDirection(
          kit.queries,
          ownerId,
          input.period.key as YearKey,
        );
        const existing = await findActiveDirection(kit.queries, ownerId, year);
        expected.push(...expectedOf(reviewed), ...expectedOf(existing));
        direction = { choice, year, reviewed, existing };
      } else if (choice === 'new') {
        const existing = await findActiveDirection(kit.queries, ownerId, year);
        expected.push(...expectedOf(existing));
        direction = { choice, year, text: input.direction?.text ?? '', existing };
      }
      decisions = { type: 'yearly', objects: input.objects, direction };
      break;
    }
  }
  return ok({ ...prepared.value, decisions, expected });
}

/* ───────────────────────── Applying decisions ───────────────────────── */

/**
 * Outcome, Milestone, and Project decisions: `continue` is recorded only; archive
 * uses the alignment archive rule (only the target changes); the others use the alignment transition rule. A
 * target already in the chosen state is left as it is.
 */
async function applyObjectDecisions(
  records: PlanningRecordReader,
  decisions: readonly ObjectDecision[],
  now: Instant,
  changes: ChangeSet,
): Promise<DomainResult<true>> {
  for (const decision of decisions) {
    const state = reviewObjectState(decision.kind, decision.decision);
    if (!state.ok) return state;
    if (state.value === null) continue;
    const current = await records.read(decision.ref);
    if (current === null) return changed('target_missing');
    if (state.value === 'archived') {
      if (isArchivedDocument(current.document)) continue;
      const archived = planAlignmentArchive(decision.kind, current, now);
      if (!archived.ok) return archived;
      changes.add(archived.value, archiveEventType(decision.kind));
      continue;
    }
    if (current.document['state'] === state.value) continue;
    const next = transitionedDocument(
      decision.kind,
      current.document,
      state.value as AlignmentState<ObjectDecision['kind']>,
    );
    if (!next.ok) return next;
    changes.add(updateFrom(current, next.value), transitionEventType(decision.kind));
  }
  return ok(true);
}

/** Set a month's theme or a year's direction through the planning rule, unless it already says so. */
async function applyPeriodText(
  records: PlanningRecordReader,
  existing: CanonicalRecordState | null,
  text: string,
  plan: () => ReturnType<typeof planMonthTheme>,
  eventType: string,
  changes: ChangeSet,
): Promise<DomainResult<true>> {
  const current = existing === null ? null : await records.read(existing.ref);
  if (
    current !== null &&
    current.document['archivedAt'] === undefined &&
    current.document['text'] === text
  )
    return ok(true);
  const planned = await plan();
  if (!planned.ok) return planned;
  changes.add(planned.value.mutation, eventType);
  if (planned.value.created !== undefined) changes.created(planned.value.created);
  return ok(true);
}

async function applyDecisions(
  kit: ReviewKit,
  session: ReviewSession,
  decisions: PreparedDecisions,
  records: PlanningRecordReader,
  context: CommandContext,
  changes: ChangeSet,
): Promise<DomainResult<true>> {
  const { ownerId, profile } = session;
  switch (decisions.type) {
    case 'daily': {
      const plan = await planEndDayMutations(kit, session, decisions.endDay, records, context);
      if (!plan.ok) return plan;
      changes.addPlan(plan.value);
      return ok(true);
    }
    case 'weekly': {
      const projects = await applyObjectDecisions(
        records,
        decisions.projects,
        context.now,
        changes,
      );
      if (!projects.ok) return projects;
      if (decisions.commitments !== null) {
        const plan = await planWeekCommitmentMutations(
          records,
          {
            ownerId,
            profileId: profile.profileId,
            week: decisions.week,
            existing: decisions.commitments.current.records,
            desired: decisions.commitments.desired,
          },
          kit.nextId,
          context,
        );
        if (!plan.ok) return plan;
        changes.addPlan(plan.value);
      }
      if (decisions.firstDay !== null) {
        const plan = await planFocusMutations(
          records,
          {
            ownerId,
            profileId: profile.profileId,
            date: decisions.firstDay.date,
            existing: decisions.firstDay.current.records,
            desired: decisions.firstDay.desired,
          },
          kit.nextId,
          context,
        );
        if (!plan.ok) return plan;
        changes.addPlan(plan.value);
      }
      return ok(true);
    }
    case 'monthly': {
      const objects = await applyObjectDecisions(records, decisions.objects, context.now, changes);
      if (!objects.ok) return objects;
      const theme = decisions.theme;
      if (theme === null) return ok(true);
      const text = monthThemeText(theme.text);
      if (!text.ok) return text;
      return applyPeriodText(
        records,
        theme.existing,
        text.value,
        () =>
          planMonthTheme(records, {
            existing: theme.existing,
            profileId: profile.profileId,
            month: theme.month,
            text: text.value,
            newRef: createEntityRef('theme', kit.nextId(), ownerId),
          }),
        themeEventTypes.monthThemeSet,
        changes,
      );
    }
    case 'yearly': {
      const objects = await applyObjectDecisions(records, decisions.objects, context.now, changes);
      if (!objects.ok) return objects;
      const direction = decisions.direction;
      if (direction === null) return ok(true);
      let written: string;
      if (direction.choice === 'continue') {
        // Continue copies the reviewed year's direction, read again inside the command.
        const reviewed =
          direction.reviewed === null ? null : await records.read(direction.reviewed.ref);
        const document = reviewed?.document as YearDirectionDocument | undefined;
        if (document === undefined || document.archivedAt !== undefined) return directionMissing();
        written = document.text;
      } else written = direction.text;
      const text = yearDirectionText(written);
      if (!text.ok) return text;
      return applyPeriodText(
        records,
        direction.existing,
        text.value,
        () =>
          planYearDirection(records, {
            existing: direction.existing,
            profileId: profile.profileId,
            year: direction.year,
            text: text.value,
            newRef: createEntityRef('direction', kit.nextId(), ownerId),
          }),
        themeEventTypes.yearDirectionSet,
        changes,
      );
    }
  }
}

/* ───────────────────────── Finish ───────────────────────── */

async function planFinish(
  kit: ReviewKit,
  session: ReviewSession,
  prepared: PreparedFinish,
  records: PlanningRecordReader,
  context: CommandContext,
): Promise<DomainResult<TodayCommandPlan>> {
  const { input, saved, desired } = prepared;
  const current = await currentReview(records, input.period, saved);
  if (!current.ok) return current;
  const allowed = planReviewFinish(reviewStatusOf(current.value));
  if (!allowed.ok) return allowed;
  const targets = await checkTargets(records, session.ownerId, desired);
  if (!targets.ok) return targets;
  const changes = createChangeSet();
  const applied = await applyDecisions(kit, session, prepared.decisions, records, context, changes);
  if (!applied.ok) return applied;
  const written = await writeReview(
    kit,
    {
      session,
      records,
      context,
      input,
      saved,
      current: current.value,
      desired,
      state: 'completed',
      eventType: reviewEventTypes.finished,
    },
    changes,
  );
  return written.ok ? ok(changes.plan()) : written;
}

/** Save the final choices, apply every decision, and complete the review, in one command. */
export async function finishReview(
  kit: ReviewKit,
  raw: unknown,
  commandId: CommandId | undefined,
): Promise<ApplicationResult<CommandReceipt>> {
  const session = await kit.session();
  const prepared = await prepareFinish(kit, session, raw);
  return kit.run(
    session.ownerId,
    commandId,
    reviewEventTypes.finished,
    prepared.ok ? prepared.value.expected : [],
    ({ records, context }) =>
      prepared.ok ? planFinish(kit, session, prepared.value, records, context) : prepared,
  );
}
