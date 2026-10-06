/**
 * Private helpers shared by the Today modules (view, focus, End Day). Like the planning scheduling
 * kit and the alignment kit, it resolves the active owner and runs one planned change as one
 * `executeCommand` transaction with minimized audit events (`{ operation }` only), per-record event
 * types, and a grouped `planning.restore_v1` undo. The planning date always comes from the injected
 * clock read in the Profile planning zone, never from the device zone.
 */
import {
  currentPlanningDate,
  entityRefKey,
  ok,
  parseCalendarDate,
  type CalendarDate,
  type CommandContext,
  type CommandId,
  type DomainResult,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import { noChange } from './alignment-kit';
import type {
  ApplicationResult,
  CanonicalMutation,
  CanonicalRecordState,
  CommandReceipt,
  ExpectedRevision,
} from './contracts';
import { executeCommand } from './execute-command';
import type { PlanProfile } from './planning-contracts';
import { applyEventTypes, planningChange, type CreatedRecord } from './planning-kit';
import { changed } from './planning-scheduling-support';
import type { ApplicationDependencies, PlanningRecordReader } from './ports';
import type { TodayQueryPort } from './today-contracts';

export interface TodaySession {
  readonly ownerId: OwnerId;
  readonly profile: PlanProfile;
  /** Planning today: the injected clock read in the Profile planning zone. */
  readonly today: CalendarDate;
}

export interface TodayCommandPlan {
  readonly mutations: readonly CanonicalMutation[];
  /** Records the command creates, so undo can archive them (or reset a materialized occurrence). */
  readonly created?: readonly CreatedRecord[];
  /**
   * Event type of one changed record when it differs from the command's own, for example
   * `focus.removed` or `time_block.skipped`. `undefined` keeps the command's event type.
   */
  readonly eventTypeFor?: (mutation: CanonicalMutation) => string | undefined;
}

export type TodayPlanner = (request: {
  readonly records: PlanningRecordReader;
  readonly context: CommandContext;
}) => DomainResult<TodayCommandPlan> | Promise<DomainResult<TodayCommandPlan>>;

export interface TodayKit {
  readonly dependencies: ApplicationDependencies;
  readonly queries: TodayQueryPort;
  /** The active planning identity; throws when none is active (the UI never calls without one). */
  ownerId(): Promise<OwnerId>;
  /** Owner, Profile planning preferences, and planning today. */
  session(): Promise<TodaySession>;
  readonly nextId: () => UUID;
  /**
   * Run one planned change as one `executeCommand` transaction. `expected` must list every record
   * the plan updates (duplicates are dropped); it is checked before the planner runs. An empty plan
   * is refused as `no_change`. Updated records are captured before any write for grouped undo, and
   * every event carries only `{ operation }`.
   */
  run(
    ownerId: OwnerId,
    commandId: CommandId | undefined,
    eventType: string,
    expected: readonly ExpectedRevision[],
    planner: TodayPlanner,
  ): Promise<ApplicationResult<CommandReceipt>>;
}

export function createTodayKit(
  dependencies: ApplicationDependencies,
  queries: TodayQueryPort,
): TodayKit {
  const ownerId = async (): Promise<OwnerId> => {
    const active = await dependencies.identityContext.getActiveIdentity();
    if (active === null) throw new Error('No active identity');
    return active.ownerId;
  };
  return {
    dependencies,
    queries,
    ownerId,
    async session() {
      const owner = await ownerId();
      const profile = await queries.getPlanProfile(owner);
      return {
        ownerId: owner,
        profile,
        today: currentPlanningDate(dependencies.clock, profile.planningTimeZone),
      };
    },
    nextId: () => dependencies.ids.next(),
    run(owner, commandId, eventType, expected, planner) {
      return executeCommand(
        dependencies,
        {
          commandId: commandId ?? dependencies.ids.next(),
          ownerId: owner,
          actor: 'user',
          expectedRevisions: uniqueExpected(expected),
          input: null,
        },
        async ({ records, context }) => {
          const planned = await planner({ records, context });
          if (!planned.ok) return planned;
          if (planned.value.mutations.length === 0) return noChange();
          // Every updated record is captured before any write so grouped undo restores it exactly.
          const prior: CanonicalRecordState[] = [];
          for (const mutation of planned.value.mutations) {
            if (mutation.operation === 'create') continue;
            const current = await records.read(mutation.ref);
            if (current === null) return changed('record_missing');
            prior.push(current);
          }
          return ok(
            applyEventTypes(
              planningChange(planned.value.mutations, context, eventType, {
                prior,
                created: planned.value.created ?? [],
              }),
              planned.value.mutations,
              planned.value.eventTypeFor,
            ),
          );
        },
      );
    },
  };
}

function uniqueExpected(expected: readonly ExpectedRevision[]): readonly ExpectedRevision[] {
  const seen = new Set<string>();
  return expected.filter((item) => {
    const key = entityRefKey(item.ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A query date: an invalid one throws `RangeError('Choose a valid date.')`, like `getDayPlan`. */
export function requireTodayDate(value: string): CalendarDate {
  const parsed = parseCalendarDate(typeof value === 'string' ? value : '');
  if (!parsed.ok) throw new RangeError('Choose a valid date.');
  return parsed.value;
}

/**
 * Per-record event types for one command: every ref not named keeps the command's event type.
 * Build it while planning, then pass `eventTypeFor` in the plan.
 */
export function eventTypesByRecord(): {
  readonly set: (mutation: CanonicalMutation, eventType: string) => void;
  readonly eventTypeFor: (mutation: CanonicalMutation) => string | undefined;
} {
  const types = new Map<string, string>();
  return {
    set: (mutation, eventType) => types.set(entityRefKey(mutation.ref), eventType),
    eventTypeFor: (mutation) => types.get(entityRefKey(mutation.ref)),
  };
}
