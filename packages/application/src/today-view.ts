/**
 * Today and Focus Part 1 — the Today view (`getToday`) and reordering the day's open flexible Actions
 * (`reorderFlexible`), . Today reads one date through the bounded day statements; the
 * reorder is one command with expected revisions, minimized events, and a grouped
 * `planning.restore_v1` undo. Nothing here ranks, preselects, or changes work by itself.
 */
import {
  createEntityRef,
  createWeekPeriod,
  dayRelation,
  ok,
  parseCalendarDate,
  parseUUID,
  reorderWithin,
  type UUID,
} from '@yelaxis/domain';

import type { CanonicalMutation, ExpectedRevision } from './contracts';
import type { PlanningPlacementDocument } from './planning-contracts';
import { domainFailure, invalid, updateFrom } from './planning-kit';
import { placedAction } from './planning-projections-range';
import { changed, rejected } from './planning-scheduling-support';
import type { TodayView, TodayViewMethods } from './today-contracts';
import { loadDay } from './today-day';
import { requireTodayDate, type TodayKit } from './today-kit';

/** The command event type of a flexible reorder (the planning placement reorder type). */
export const flexibleReorderEventType = 'planning.placement_reordered';

export function createTodayView(kit: TodayKit): TodayViewMethods {
  return {
    async getToday(value) {
      const date = requireTodayDate(value);
      const session = await kit.session();
      const { profile, today } = session;
      const day = await loadDay(kit, session, date);
      const view: TodayView = {
        profile,
        date,
        today,
        relation: dayRelation(date, today),
        week: createWeekPeriod(date, profile.weekStart),
        focus: day.focus,
        focusEditable: date >= today,
        timeline: {
          entries: day.column.timed,
          conflicts: day.conflicts,
          capacity: day.column.capacity,
          availability: day.column.availability,
        },
        flexible: {
          open: day.openFlexible.map(placedAction),
          done: day.doneFlexible.map(placedAction),
        },
        routines: {
          // Timed occurrences are on the timeline; the Routines list holds the untimed ones.
          day: day.column.flexibleOccurrences,
          week: day.weekOccurrences,
        },
        endDayAvailable: date <= today,
      };
      return view;
    },

    async reorderFlexible(input, commandId) {
      const date = parseCalendarDate(typeof input.date === 'string' ? input.date : '');
      if (!date.ok) return rejected(date.error);
      const placementId = parseUUID(typeof input.placementId === 'string' ? input.placementId : '');
      if (!placementId.ok) return rejected(placementId.error);
      if (input.direction !== 'up' && input.direction !== 'down')
        return domainFailure(invalid('direction', 'Choose Move up or Move down.'));
      if (!Number.isSafeInteger(input.revision) || input.revision < 1)
        return domainFailure(invalid('revision'));

      const session = await kit.session();
      const { ownerId } = session;
      const day = await loadDay(kit, session, date.value);
      // Only the open flexible list is reordered: the day's placement container also holds
      // scheduled, finished, and hidden rows, which keep their keys (`in_place`).
      const rows = day.openFlexible;
      if (!rows.some((row) => row.id === placementId.value))
        return domainFailure(
          invalid(
            'not_in_list',
            'This Action is no longer in this day’s flexible list. Refresh it and try again.',
          ),
        );
      const changes = reorderWithin(
        rows.map((row) => ({ id: row.id, orderKey: row.orderKey })),
        placementId.value,
        input.direction,
        'in_place',
      );
      if (!changes.ok) return rejected(changes.error);
      const byId = new Map<string, (typeof rows)[number]>(rows.map((row) => [row.id, row]));
      const moves = changes.value.flatMap((change) => {
        const row = byId.get(change.id);
        return row === undefined ? [] : [{ row, orderKey: change.orderKey }];
      });
      const placementRef = (id: UUID) => createEntityRef('planning_placement', id, ownerId);
      const expected: ExpectedRevision[] = [
        // The moving row is expected at the revision the person saw, even if its key is unchanged.
        { ref: placementRef(placementId.value), revision: input.revision },
        ...moves
          .filter(({ row }) => row.id !== placementId.value)
          .map(({ row }) => ({ ref: placementRef(row.id), revision: row.localRevision })),
      ];
      return kit.run(
        ownerId,
        commandId,
        flexibleReorderEventType,
        expected,
        async ({ records }) => {
          const mutations: CanonicalMutation[] = [];
          for (const { row, orderKey } of moves) {
            const current = await records.read(placementRef(row.id));
            if (current === null) return changed('order_changed');
            const document = current.document as PlanningPlacementDocument;
            if (document.archivedAt !== undefined || document.orderKey !== row.orderKey)
              return changed('order_changed');
            mutations.push(updateFrom(current, { ...document, orderKey }));
          }
          return ok({ mutations });
        },
      );
    },
  };
}
