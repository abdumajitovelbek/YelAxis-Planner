/**
 * Test-only planning query port over the in-memory unit of work. It answers the reads the Routine
 * and Template commands use, derived directly from canonical documents; unused reads throw.
 */
import {
  intervalsIntersect,
  occurrenceLogicalKey,
  periodRange,
  rangesOverlap,
  type MaterializedOccurrenceSnapshot,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import type { ActionCanonicalDocument } from './actions';
import type { CanonicalRecordState } from './contracts';
import type {
  ActionSummary,
  BlockRow,
  BlockTargetView,
  CommitmentDocument,
  PlacementRow,
  PlanProfile,
  PlanningPlacementDocument,
  PlanningQueryPort,
  RoutineDocument,
  RoutineOccurrenceDocument,
  RoutineRow,
  TemplateDocument,
  TemplateRow,
  TimeBlockDocument,
} from './planning-contracts';
import { routineDefaultsId } from './planning-routines-support';
import type { InMemoryUnitOfWork } from './testing/in-memory-unit-of-work';

const unused = (name: string) => (): never => {
  throw new Error(`Test query ${name} is not implemented.`);
};

export function createTestPlanningQueries(
  unitOfWork: InMemoryUnitOfWork,
  profile: PlanProfile,
): PlanningQueryPort {
  const all = (type: string, ownerId: OwnerId): CanonicalRecordState[] =>
    [...unitOfWork.state.records.values()].filter(
      (record) => record.ref.type === type && record.ref.ownerId === ownerId,
    );
  const find = (type: string, ownerId: OwnerId, id: string): CanonicalRecordState | undefined =>
    all(type, ownerId).find((record) => record.ref.id === id);

  const placementOf = (ownerId: OwnerId, actionId: UUID) =>
    all('planning_placement', ownerId).find((record) => {
      const document = record.document as PlanningPlacementDocument;
      return (
        document.archivedAt === undefined &&
        document.target.kind === 'action' &&
        document.target.actionId === actionId
      );
    });

  const actionSummary = (ownerId: OwnerId, record: CanonicalRecordState): ActionSummary => {
    const document = record.document as ActionCanonicalDocument;
    const placement = placementOf(ownerId, record.ref.id);
    return {
      id: record.ref.id,
      title: document.title,
      state: document.state,
      localRevision: record.localRevision,
      orderKey: document.orderKey,
      ...(document.estimateMinutes === undefined
        ? {}
        : { estimateMinutes: document.estimateMinutes }),
      ...(document.energy === undefined ? {} : { energy: document.energy }),
      ...(document.priority === undefined ? {} : { priority: document.priority }),
      ...(document.due === undefined ? {} : { due: document.due }),
      ...(placement === undefined
        ? {}
        : {
            placement: {
              id: placement.ref.id,
              localRevision: placement.localRevision,
              period: (placement.document as PlanningPlacementDocument).period,
            },
          }),
    };
  };

  const blockTarget = (ownerId: OwnerId, document: TimeBlockDocument): BlockTargetView => {
    switch (document.target.kind) {
      case 'action': {
        const action = find('action', ownerId, document.target.actionId);
        const actionDocument = action?.document as ActionCanonicalDocument | undefined;
        return {
          kind: 'action',
          actionId: document.target.actionId,
          title: actionDocument?.title ?? '',
          actionState: actionDocument?.state ?? 'planned',
          actionRevision: action?.localRevision ?? 0,
        };
      }
      case 'commitment': {
        const commitment = find('commitment', ownerId, document.target.commitmentId);
        const commitmentDocument = commitment?.document as CommitmentDocument | undefined;
        return {
          kind: 'commitment',
          commitmentId: document.target.commitmentId,
          title: commitmentDocument?.title ?? '',
          strength: commitmentDocument?.strength ?? 'soft',
          commitmentState: commitmentDocument?.state ?? 'planned',
          commitmentRevision: commitment?.localRevision ?? 0,
        };
      }
      case 'routine_occurrence':
        return {
          kind: 'routine_occurrence',
          routineOccurrenceId: document.target.routineOccurrenceId,
          title: '',
        };
      case 'custom':
        return { kind: 'custom', title: document.target.title };
    }
  };

  const routineRow = (ownerId: OwnerId, record: CanonicalRecordState): RoutineRow => {
    const document = record.document as RoutineDocument;
    const generation = document.generations.at(-1)?.generation ?? 1;
    const defaults = find(
      'routine_action_defaults',
      ownerId,
      routineDefaultsId(record.ref.id, generation),
    );
    return {
      id: record.ref.id,
      localRevision: record.localRevision,
      document,
      ...(defaults === undefined
        ? {}
        : {
            defaults: {
              ...(defaults.document as RoutineRow['defaults'] & object),
              id: defaults.ref.id,
              localRevision: defaults.localRevision,
            },
          }),
    };
  };

  const templateRow = (record: CanonicalRecordState): TemplateRow => ({
    id: record.ref.id,
    localRevision: record.localRevision,
    document: record.document as TemplateDocument,
  });

  const occurrenceSnapshot = (record: CanonicalRecordState): MaterializedOccurrenceSnapshot => {
    const document = record.document as RoutineOccurrenceDocument;
    return {
      id: record.ref.id,
      routineId: document.routineId,
      generation: document.generation,
      logicalKey: occurrenceLogicalKey(document.routineId, document.generation, document.period),
      period: document.period,
      state: document.state,
      localRevision: record.localRevision,
      ...(document.targetCount === undefined ? {} : { targetCount: document.targetCount }),
      ...(document.completedCount === undefined ? {} : { completedCount: document.completedCount }),
      ...(document.extraCompletionsConfirmed === undefined
        ? {}
        : { extraCompletionsConfirmed: document.extraCompletionsConfirmed }),
      ...(document.override === undefined ? {} : { override: document.override }),
      ...(document.completedAt === undefined ? {} : { completedAt: document.completedAt }),
    };
  };

  return {
    getPlanProfile: () => Promise.resolve(profile),
    listBlocks(ownerId, startsAt, endsAt) {
      const rows: BlockRow[] = [];
      for (const record of all('time_block', ownerId)) {
        const document = record.document as TimeBlockDocument;
        if (document.state === 'canceled' || document.supersededById !== undefined) continue;
        if (!intervalsIntersect(document, { startsAt, endsAt })) continue;
        rows.push({
          id: record.ref.id,
          localRevision: record.localRevision,
          startsAt: document.startsAt,
          endsAt: document.endsAt,
          timeZone: document.timeZone,
          state: document.state,
          overlapAcknowledged: document.overlapAcknowledged,
          target: blockTarget(ownerId, document),
        });
      }
      return Promise.resolve(rows);
    },
    listPlacements(ownerId, range) {
      const rows: PlacementRow[] = [];
      for (const record of all('planning_placement', ownerId)) {
        const document = record.document as PlanningPlacementDocument;
        if (document.archivedAt !== undefined) continue;
        if (!rangesOverlap(periodRange(document.period), range)) continue;
        if (document.target.kind !== 'action') continue;
        const action = find('action', ownerId, document.target.actionId);
        if (action === undefined) continue;
        rows.push({
          id: record.ref.id,
          localRevision: record.localRevision,
          period: document.period,
          orderKey: document.orderKey,
          target: { kind: 'action', action: actionSummary(ownerId, action) },
        });
      }
      return Promise.resolve(rows);
    },
    listBacklog: unused('listBacklog'),
    listCarryForward: unused('listCarryForward'),
    listWeekSelections: unused('listWeekSelections'),
    listRoutines(ownerId, options) {
      return Promise.resolve(
        all('routine', ownerId)
          .filter(
            (record) =>
              options.includeArchived || (record.document as RoutineDocument).state !== 'archived',
          )
          .map((record) => routineRow(ownerId, record)),
      );
    },
    getRoutine(ownerId, routineId) {
      const record = find('routine', ownerId, routineId);
      return Promise.resolve(record === undefined ? null : routineRow(ownerId, record));
    },
    listMaterializedOccurrences(ownerId, range, routineId) {
      return Promise.resolve(
        all('routine_occurrence', ownerId)
          .map(occurrenceSnapshot)
          .filter((row) => routineId === undefined || row.routineId === routineId)
          .filter((row) => {
            if (row.period.kind === 'week')
              return rangesOverlap({ start: row.period.start, end: row.period.end }, range);
            const dates = [row.period.date, row.override?.date].filter(
              (value): value is NonNullable<typeof value> => value !== undefined,
            );
            return dates.some((date) => date >= range.start && date <= range.end);
          }),
      );
    },
    listOccurrenceHistory: unused('listOccurrenceHistory'),
    listCapacityConstraints: unused('listCapacityConstraints'),
    listMonthThemes: unused('listMonthThemes'),
    getYearDirection: unused('getYearDirection'),
    listOutcomes: unused('listOutcomes'),
    listMilestones: unused('listMilestones'),
    listProjectTargets: unused('listProjectTargets'),
    getMilestoneChain: unused('getMilestoneChain'),
    listTemplates(ownerId, options) {
      return Promise.resolve(
        all('template', ownerId)
          .map(templateRow)
          .filter((row) => options.includeArchived || row.document.state !== 'archived'),
      );
    },
    getTemplate(ownerId, templateId) {
      const record = find('template', ownerId, templateId);
      return Promise.resolve(record === undefined ? null : templateRow(record));
    },
    listAxes(ownerId) {
      return Promise.resolve(
        all('axis', ownerId)
          .filter((record) => record.document['state'] === 'active')
          .map((record) => ({
            id: record.ref.id,
            title: String(record.document['title']),
            localRevision: record.localRevision,
          })),
      );
    },
    listProjects(ownerId) {
      return Promise.resolve(
        all('project', ownerId)
          .filter((record) => ['idea', 'active'].includes(String(record.document['state'])))
          .map((record) => ({
            id: record.ref.id,
            title: String(record.document['title']),
            localRevision: record.localRevision,
          })),
      );
    },
    getAction(ownerId, actionId) {
      const record = find('action', ownerId, actionId);
      return Promise.resolve(record === undefined ? null : actionSummary(ownerId, record));
    },
    readRecord(ownerId, ref) {
      return Promise.resolve(
        ref.ownerId === ownerId ? (find(ref.type, ownerId, ref.id) ?? null) : null,
      );
    },
    getActivePlacement(ownerId, kind, targetId) {
      const record = all('planning_placement', ownerId).find((candidate) => {
        const document = candidate.document as PlanningPlacementDocument;
        const target = document.target as Readonly<Record<string, unknown>>;
        return (
          document.archivedAt === undefined &&
          document.target.kind === kind &&
          target[`${kind}Id`] === targetId
        );
      });
      return Promise.resolve(record ?? null);
    },
    getPlannedActionBlock(ownerId, actionId) {
      const record = all('time_block', ownerId).find((candidate) => {
        const document = candidate.document as TimeBlockDocument;
        return (
          document.state === 'planned' &&
          document.supersededById === undefined &&
          document.target.kind === 'action' &&
          document.target.actionId === actionId
        );
      });
      return Promise.resolve(record ?? null);
    },
    getPlannedCommitmentBlock: unused('getPlannedCommitmentBlock'),
    getTargetReminder(ownerId, target) {
      // The scheduled reminder, else the last one created (the store keeps no update time).
      const key = target.kind === 'time_block' ? 'timeBlockId' : 'routineId';
      const reminders = all('reminder', ownerId).filter(
        (record) => record.document[key] === target.id,
      );
      return Promise.resolve(
        reminders.find((record) => record.document['state'] === 'scheduled') ??
          reminders.at(-1) ??
          null,
      );
    },
  };
}
