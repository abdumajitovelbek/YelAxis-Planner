/**
 * Planning-zone preview and change (time-horizon-recurrence "Planning time zone").
 *
 * The Profile planning zone never changes silently: the web asks, shows this preview, and runs
 * `changePlanningZone` only on the user's explicit choice. The command writes only the Profile's
 * planning zone; fixed Time Blocks keep their UTC instants and date-only intent never moves.
 */
import {
  addDays,
  createEntityRef,
  currentPlanningDate,
  ok,
  parseIanaTimeZone,
  previewPlanningZoneChange,
  type EntityRef,
} from '@yelaxis/domain';

import type { PlanningApplication, PlanningQueryPort } from './planning-contracts';
import { domainFailure, updateFrom } from './planning-kit';
import { resolveOwner } from './planning-routines-support';
import {
  changed,
  createSchedulingKit,
  invalid,
  rejectInvalid,
} from './planning-scheduling-support';
import { routineSnapshot } from './planning-timed-items';
import type { ApplicationDependencies } from './ports';

export type PlanningZoneMethods = Pick<
  PlanningApplication,
  'previewPlanningZoneChange' | 'changePlanningZone'
>;

/** Upcoming local days examined by the preview, starting today in the current planning zone. */
const previewDays = 28;
const occurrencesPerRoutine = 3;

export function createPlanningZoneCommands(
  dependencies: ApplicationDependencies,
  queries: PlanningQueryPort,
): PlanningZoneMethods {
  const kit = createSchedulingKit(dependencies, queries);
  return {
    async previewPlanningZoneChange(zone) {
      const target = parseIanaTimeZone(typeof zone === 'string' ? zone : '');
      if (!target.ok) return domainFailure(target);
      const owner = await resolveOwner(dependencies);
      if (!owner.ok) return owner;
      const ownerId = owner.value;
      const profile = await queries.getPlanProfile(ownerId);
      const ref = createEntityRef('profile', profile.profileId, ownerId);
      const record = await queries.readRecord(ownerId, ref);
      if (record === null) return { ok: false, error: { code: 'entity_not_found', ref } };
      const today = currentPlanningDate(dependencies.clock, profile.planningTimeZone);
      const window = { start: today, end: addDays(today, previewDays - 1) };
      const rows = await queries.listRoutines(ownerId, { includeArchived: false });
      const materialized = await queries.listMaterializedOccurrences(ownerId, window);
      const preview = previewPlanningZoneChange({
        routines: rows.map((row) => ({ title: row.document.title, series: routineSnapshot(row) })),
        materialized,
        from: profile.planningTimeZone,
        to: target.value,
        window,
        occurrencesPerRoutine,
        notBefore: dependencies.clock.now(),
      });
      if (!preview.ok) return domainFailure(preview);
      return { ok: true, value: { ...preview.value, profileRevision: record.localRevision } };
    },

    async changePlanningZone(input, commandId) {
      const target = parseIanaTimeZone(typeof input.zone === 'string' ? input.zone : '');
      if (!target.ok) return domainFailure(target);
      if (!Number.isSafeInteger(input.revision) || input.revision < 1)
        return rejectInvalid('revision');
      const owner = await resolveOwner(dependencies);
      if (!owner.ok) return owner;
      const ownerId = owner.value;
      const profile = await queries.getPlanProfile(ownerId);
      const ref: EntityRef = createEntityRef('profile', profile.profileId, ownerId);
      return kit.run(
        ownerId,
        commandId,
        'profile.planning_zone_changed',
        [{ ref, revision: input.revision }],
        async ({ records }) => {
          const current = await records.read(ref);
          if (current === null) return changed('profile_missing');
          if (current.document['planningTimeZone'] === target.value)
            return invalid('no_change', 'Your plan already uses this time zone.');
          return ok({
            mutations: [
              updateFrom(current, { ...current.document, planningTimeZone: target.value }),
            ],
          });
        },
      );
    },
  };
}
