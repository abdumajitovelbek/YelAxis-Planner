/**
 * Test-only alignment query port over the in-memory unit of work, plus a small fixture seeder. Every
 * read is derived from the canonical documents and follows the port's documented semantics closely
 * enough for application unit tests of the alignment projections and commands. It never writes.
 */
import {
  alignmentLinkEntityType,
  alignmentRelationshipsAbove,
  alignmentRelationshipsBelow,
  compareOrder,
  countMilestoneProgress,
  createEntityRef,
  currentOutcomeStates,
  currentProjectStates,
  currentRoutineStates,
  entityRefKey,
  outcomeProgress,
  projectNextAction,
  spacedOrderKey,
  type AlignmentJoinRelationship,
  type AlignmentKind,
  type AlignmentNodeKind,
  type AlignmentRelationshipRule,
  type EntityRef,
  type EntityType,
  type HorizonPeriod,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import type { ActionCanonicalDocument } from '../actions';
import type {
  AlignmentContainerRow,
  AlignmentEdge,
  AlignmentNode,
  AlignmentQueryPort,
  AxisSummary,
  Bounded,
  DeleteImpactRecords,
  DeleteReferrerRelationship,
  HistoryEntry,
  LinkedItem,
  MilestoneItem,
  NodeRef,
  OutcomeItem,
  ProjectItem,
} from '../alignment-contracts';
import { isActiveLink, linkDocument, linkEndpoints, linkRef } from '../alignment-kit';
import type { CanonicalRecordState } from '../contracts';
import type {
  AxisDocument,
  FocusSelectionDocument,
  MilestoneDocument,
  NoteDocument,
  OutcomeDocument,
  PlanningPlacementDocument,
  ProjectDocument,
} from '../planning-contracts';
import type { ReviewDocument, ReviewItemDocument } from '../review-contracts';
import type { InMemoryUnitOfWork } from './in-memory-unit-of-work';

type Doc = Readonly<Record<string, unknown>>;

const maxLimit = 200;

const clampLimit = (limit: number): number =>
  Number.isFinite(limit) ? Math.max(0, Math.min(Math.trunc(limit), maxLimit)) : maxLimit;

const bounded = <T>(items: readonly T[], limit: number): Bounded<T> => ({
  items: items.slice(0, clampLimit(limit)),
  total: items.length,
});

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const isArchived = (document: Doc): boolean =>
  document['state'] === 'archived' || document['archivedAt'] !== undefined;

const byOrder = (left: CanonicalRecordState, right: CanonicalRecordState): number =>
  compareOrder(
    { id: left.ref.id, orderKey: text(left.document['orderKey']) ?? '' },
    { id: right.ref.id, orderKey: text(right.document['orderKey']) ?? '' },
  );

const titleOf = (record: CanonicalRecordState): string =>
  text(record.document['title']) ?? text(record.document['body']) ?? '';

const nodeRef = (record: CanonicalRecordState): NodeRef => ({
  id: record.ref.id,
  title: titleOf(record),
  state: text(record.document['state']) ?? 'active',
  archived: isArchived(record.document),
});

const alignmentNode = (kind: AlignmentNodeKind, record: CanonicalRecordState): AlignmentNode => ({
  ...nodeRef(record),
  kind,
  localRevision: record.localRevision,
});

const linkedItem = <K extends AlignmentNodeKind>(
  kind: K,
  record: CanonicalRecordState,
  link?: CanonicalRecordState,
): LinkedItem<K> => ({
  ...nodeRef(record),
  kind,
  localRevision: record.localRevision,
  ...(link === undefined ? {} : { linkId: link.ref.id, linkRevision: link.localRevision }),
});

export function createAlignmentTestQueries(unitOfWork: InMemoryUnitOfWork): AlignmentQueryPort {
  const all = (ownerId: OwnerId, type: EntityType): CanonicalRecordState[] =>
    [...unitOfWork.state.records.values()].filter(
      (record) => record.ref.type === type && record.ref.ownerId === ownerId,
    );
  const find = (ownerId: OwnerId, type: EntityType, id: unknown): CanonicalRecordState | null =>
    typeof id === 'string'
      ? (all(ownerId, type).find((record) => record.ref.id === id) ?? null)
      : null;
  const referencing = (
    ownerId: OwnerId,
    type: EntityType,
    key: string,
    id: string,
  ): CanonicalRecordState[] =>
    all(ownerId, type)
      .filter((record) => record.document[key] === id)
      .sort(byOrder);
  const live = (records: CanonicalRecordState[]) =>
    records.filter((record) => !isArchived(record.document));

  const joins = (
    ownerId: OwnerId,
    relationship: AlignmentJoinRelationship,
    side: 'parentId' | 'childId',
    id: string,
  ): CanonicalRecordState[] =>
    all(ownerId, alignmentLinkEntityType(relationship)).filter(
      (record) => linkEndpoints(relationship, record.document)?.[side] === id,
    );
  /** Active links with the endpoint on the other side, ordered by that endpoint. */
  const linked = (
    ownerId: OwnerId,
    relationship: AlignmentJoinRelationship,
    side: 'parentId' | 'childId',
    id: string,
    otherType: EntityType,
  ): { readonly link: CanonicalRecordState; readonly other: CanonicalRecordState }[] =>
    joins(ownerId, relationship, side, id)
      .filter((link) => isActiveLink(link.document))
      .flatMap((link) => {
        const endpoints = linkEndpoints(relationship, link.document);
        const otherId = side === 'parentId' ? endpoints?.childId : endpoints?.parentId;
        const other = find(ownerId, otherType, otherId);
        return other === null ? [] : [{ link, other }];
      })
      .sort((left, right) => byOrder(left.other, right.other));

  const placementOf = (ownerId: OwnerId, kind: AlignmentKind | 'action', id: string) => {
    const record = all(ownerId, 'planning_placement').find((candidate) => {
      const document = candidate.document as PlanningPlacementDocument;
      const target = document.target as Readonly<Record<string, unknown>>;
      return (
        document.archivedAt === undefined &&
        document.target.kind === kind &&
        target[`${kind}Id`] === id
      );
    });
    return record === undefined
      ? {}
      : {
          placement: {
            id: record.ref.id,
            period: (record.document as PlanningPlacementDocument).period,
          },
        };
  };

  const outcomeItem = (ownerId: OwnerId, record: CanonicalRecordState): OutcomeItem => {
    const document = record.document as OutcomeDocument;
    const counts = countMilestoneProgress(
      referencing(ownerId, 'milestone', 'outcomeId', record.ref.id).map(
        (milestone) => (milestone.document as MilestoneDocument).state,
      ),
    );
    const axis = find(ownerId, 'axis', document.axisId);
    return {
      id: record.ref.id,
      localRevision: record.localRevision,
      title: document.title,
      successDefinition: document.successDefinition,
      state: document.state,
      ...(document.stateBeforeArchive === undefined
        ? {}
        : { stateBeforeArchive: document.stateBeforeArchive }),
      ...(axis === null ? {} : { axis: nodeRef(axis) }),
      ...(document.targetStart === undefined ? {} : { targetStart: document.targetStart }),
      ...(document.targetEnd === undefined ? {} : { targetEnd: document.targetEnd }),
      progress: outcomeProgress(document.progress, counts),
      canceledMilestones: counts.canceled,
      ...placementOf(ownerId, 'outcome', record.ref.id),
      orderKey: document.orderKey,
    };
  };

  const projectItem = (ownerId: OwnerId, record: CanonicalRecordState): ProjectItem => {
    const document = record.document as ProjectDocument;
    const next = projectNextAction(
      document.state,
      referencing(ownerId, 'action', 'projectId', record.ref.id).map((action) => {
        const actionDocument = action.document as ActionCanonicalDocument;
        return {
          id: action.ref.id,
          title: actionDocument.title,
          state: actionDocument.state,
          orderKey: actionDocument.orderKey,
        };
      }),
    );
    const axis = find(ownerId, 'axis', document.axisId);
    const primary = find(ownerId, 'outcome', document.primaryOutcomeId);
    return {
      id: record.ref.id,
      localRevision: record.localRevision,
      title: document.title,
      state: document.state,
      ...(document.stateBeforeArchive === undefined
        ? {}
        : { stateBeforeArchive: document.stateBeforeArchive }),
      ...(document.desiredResult === undefined ? {} : { desiredResult: document.desiredResult }),
      ...(axis === null ? {} : { axis: nodeRef(axis) }),
      ...(primary === null ? {} : { primaryOutcome: nodeRef(primary) }),
      ...(document.targetStart === undefined ? {} : { targetStart: document.targetStart }),
      ...(document.targetEnd === undefined ? {} : { targetEnd: document.targetEnd }),
      ...placementOf(ownerId, 'project', record.ref.id),
      orderKey: document.orderKey,
      nextAction:
        next.status === 'present'
          ? {
              status: 'present',
              action: { id: next.action.id, title: next.action.title, state: next.action.state },
            }
          : next,
    };
  };

  const milestoneItem = (ownerId: OwnerId, record: CanonicalRecordState): MilestoneItem => {
    const document = record.document as MilestoneDocument;
    const outcome = find(ownerId, 'outcome', document.outcomeId);
    return {
      id: record.ref.id,
      localRevision: record.localRevision,
      title: document.title,
      measurableCheckpoint: document.measurableCheckpoint,
      state: document.state,
      ...(document.stateBeforeArchive === undefined
        ? {}
        : { stateBeforeArchive: document.stateBeforeArchive }),
      outcome:
        outcome === null
          ? { id: document.outcomeId, title: '', state: 'active', archived: false }
          : nodeRef(outcome),
      ...(document.targetStart === undefined ? {} : { targetStart: document.targetStart }),
      ...(document.targetEnd === undefined ? {} : { targetEnd: document.targetEnd }),
      ...placementOf(ownerId, 'milestone', record.ref.id),
      orderKey: document.orderKey,
    };
  };

  const axisSummary = (ownerId: OwnerId, record: CanonicalRecordState): AxisSummary => {
    const document = record.document as AxisDocument;
    const members = (type: EntityType, states: readonly string[]) =>
      referencing(ownerId, type, 'axisId', record.ref.id).filter((member) =>
        states.includes(text(member.document['state']) ?? ''),
      ).length;
    return {
      id: record.ref.id,
      localRevision: record.localRevision,
      title: document.title,
      ...(document.purpose === undefined ? {} : { purpose: document.purpose }),
      ...(document.color === undefined ? {} : { color: document.color }),
      ...(document.icon === undefined ? {} : { icon: document.icon }),
      state: document.state,
      orderKey: document.orderKey,
      ...(document.archivedAt === undefined ? {} : { archivedAt: document.archivedAt }),
      counts: {
        outcomes: members('outcome', currentOutcomeStates),
        projects: members('project', currentProjectStates),
        routines: members('routine', currentRoutineStates),
      },
    };
  };

  const listHistory = (ownerId: OwnerId, ref: EntityRef, limit: number): HistoryEntry[] =>
    unitOfWork.state.events
      .filter(
        (record) =>
          record.ownerId === ownerId && entityRefKey(record.event.aggregate) === entityRefKey(ref),
      )
      .sort(
        (left, right) =>
          right.event.occurredAt.localeCompare(left.event.occurredAt) ||
          right.eventId.localeCompare(left.eventId),
      )
      .slice(0, clampLimit(limit))
      .map((record) => ({
        eventType: record.event.eventType,
        occurredAt: record.event.occurredAt,
      }));

  /** Parent ancestry along required and primary links, Axis first; the focus is not included. */
  const chainOf = (
    ownerId: OwnerId,
    kind: AlignmentNodeKind,
    record: CanonicalRecordState,
    depth = 0,
  ): AlignmentNode[] => {
    if (depth > 4) return [];
    const up = (parentKind: AlignmentNodeKind, id: unknown): AlignmentNode[] | null => {
      const parent = find(ownerId, parentKind, id);
      return parent === null
        ? null
        : [...chainOf(ownerId, parentKind, parent, depth + 1), alignmentNode(parentKind, parent)];
    };
    switch (kind) {
      case 'axis':
        return [];
      case 'outcome':
      case 'routine':
        return up('axis', record.document['axisId']) ?? [];
      case 'milestone':
        return up('outcome', record.document['outcomeId']) ?? [];
      case 'project':
        return (
          up('outcome', record.document['primaryOutcomeId']) ??
          up('axis', record.document['axisId']) ??
          []
        );
      case 'action':
      case 'note':
        return (
          up('project', record.document['projectId']) ?? up('axis', record.document['axisId']) ?? []
        );
    }
  };

  const edgesFor = (
    ownerId: OwnerId,
    rule: AlignmentRelationshipRule,
    direction: 'up' | 'down',
    focus: CanonicalRecordState,
  ): AlignmentEdge[] => {
    const edge = (other: CanonicalRecordState, link?: CanonicalRecordState): AlignmentEdge => ({
      relationship: rule.relationship,
      direction,
      required: rule.required,
      ...(link === undefined ? {} : { linkId: link.ref.id, linkRevision: link.localRevision }),
      other: alignmentNode(direction === 'up' ? rule.parentKind : rule.childKind, other),
    });
    if (rule.storage === 'join') {
      const relationship = rule.relationship as AlignmentJoinRelationship;
      return direction === 'up'
        ? linked(ownerId, relationship, 'childId', focus.ref.id, rule.parentKind).map(
            ({ link, other }) => edge(other, link),
          )
        : linked(ownerId, relationship, 'parentId', focus.ref.id, rule.childKind).map(
            ({ link, other }) => edge(other, link),
          );
    }
    if (direction === 'up') {
      const parent = find(ownerId, rule.parentKind, focus.document[rule.foreignKey]);
      return parent === null ? [] : [edge(parent)];
    }
    return referencing(ownerId, rule.childKind, rule.foreignKey, focus.ref.id).map((child) =>
      edge(child),
    );
  };

  const deleteImpact = (ownerId: OwnerId, ref: EntityRef): DeleteImpactRecords => {
    const optionalReferrers: DeleteImpactRecords['optionalReferrers'][number][] = [];
    const refer = (type: EntityType, key: string, relationship: DeleteReferrerRelationship) => {
      for (const record of referencing(ownerId, type, key, ref.id))
        optionalReferrers.push({ record, relationship, title: titleOf(record) });
    };
    const links: CanonicalRecordState[] = [];
    const joined = (relationship: AlignmentJoinRelationship, side: 'parentId' | 'childId') =>
      links.push(...joins(ownerId, relationship, side, ref.id));
    const byTarget: Partial<Record<EntityType, () => void>> = {
      axis: () => {
        refer('outcome', 'axisId', 'axis_outcome');
        refer('project', 'axisId', 'axis_project');
        refer('routine', 'axisId', 'axis_routine');
        refer('action', 'axisId', 'axis_action');
        refer('note', 'axisId', 'axis_note');
      },
      outcome: () => {
        refer('project', 'primaryOutcomeId', 'outcome_primary_project');
        joined('outcome_secondary_project', 'parentId');
      },
      project: () => {
        refer('action', 'projectId', 'project_action');
        refer('note', 'projectId', 'project_note');
        joined('outcome_secondary_project', 'childId');
        joined('milestone_project', 'childId');
      },
      milestone: () => {
        joined('milestone_project', 'parentId');
        joined('milestone_action', 'parentId');
      },
      action: () => {
        joined('milestone_action', 'childId');
      },
    };
    byTarget[ref.type]?.();
    const targets = (type: 'planning_placement' | 'focus_selection') =>
      all(ownerId, type).filter((record) => {
        const target = (record.document as PlanningPlacementDocument | FocusSelectionDocument)
          .target as Readonly<Record<string, unknown>>;
        return target['kind'] === ref.type && target[`${ref.type}Id`] === ref.id;
      });
    const placements = targets('planning_placement');
    const selections = targets('focus_selection');
    const milestones =
      ref.type === 'outcome' ? referencing(ownerId, 'milestone', 'outcomeId', ref.id) : [];
    // Review items naming the target in any state, in id order, like the SQLite adapter.
    const reviewItems = all(ownerId, 'review_item')
      .filter((record) => {
        const target = record.document['target'];
        if (typeof target !== 'object' || target === null) return false;
        const named = target as Doc;
        return named['kind'] === ref.type && named[`${ref.type}Id`] === ref.id;
      })
      .sort((left, right) =>
        left.ref.id < right.ref.id ? -1 : left.ref.id > right.ref.id ? 1 : 0,
      );
    return {
      optionalReferrers,
      activeLinks: links.filter((link) => isActiveLink(link.document)),
      inactiveLinks: links.filter((link) => !isActiveLink(link.document)),
      activePlacements: placements.filter((record) => record.document['archivedAt'] === undefined),
      archivedPlacements: placements.filter(
        (record) => record.document['archivedAt'] !== undefined,
      ),
      activeSelections: selections.filter((record) => record.document['archivedAt'] === undefined),
      archivedSelections: selections.filter(
        (record) => record.document['archivedAt'] !== undefined,
      ),
      requiredChildren: bounded(
        milestones.map((milestone) => ({
          id: milestone.ref.id,
          title: titleOf(milestone),
          archived: isArchived(milestone.document),
        })),
        maxLimit,
      ),
      reviewItems,
      reviewReferences: reviewItems.length,
      routineDefaultReferences:
        ref.type === 'project'
          ? referencing(ownerId, 'routine_action_defaults', 'projectId', ref.id).length
          : 0,
      pendingMutation: unitOfWork.state.outbox.some((group) =>
        group.operations.some(
          (operation) => entityRefKey(operation.mutation.ref) === entityRefKey(ref),
        ),
      ),
      openConflict: false,
    };
  };

  return {
    readRecord(ownerId, ref) {
      return Promise.resolve(ref.ownerId === ownerId ? find(ownerId, ref.type, ref.id) : null);
    },
    listAxes(ownerId, options) {
      const rows = all(ownerId, 'axis')
        .filter((record) => options.includeArchived || !isArchived(record.document))
        .sort(
          (left, right) =>
            Number(isArchived(left.document)) - Number(isArchived(right.document)) ||
            byOrder(left, right),
        );
      return Promise.resolve(
        bounded(
          rows.map((record) => axisSummary(ownerId, record)),
          options.limit,
        ),
      );
    },
    listUnassigned(ownerId, limit) {
      const unassigned = (type: EntityType) =>
        live(all(ownerId, type))
          .filter((record) => record.document['axisId'] === undefined)
          .sort(byOrder);
      return Promise.resolve({
        outcomes: bounded(
          unassigned('outcome').map((record) => outcomeItem(ownerId, record)),
          limit,
        ),
        projects: bounded(
          unassigned('project').map((record) => projectItem(ownerId, record)),
          limit,
        ),
      });
    },
    getAxis(ownerId, id, options) {
      const axis = find(ownerId, 'axis', id);
      if (axis === null) return Promise.resolve(null);
      const members = (type: EntityType, current: readonly string[], finished: readonly string[]) =>
        referencing(ownerId, type, 'axisId', id).filter((record) => {
          const state = text(record.document['state']) ?? '';
          return current.includes(state) || (options.includeFinished && finished.includes(state));
        });
      return Promise.resolve({
        axis: axisSummary(ownerId, axis),
        outcomes: bounded(
          members('outcome', currentOutcomeStates, ['achieved', 'abandoned']).map((record) =>
            outcomeItem(ownerId, record),
          ),
          options.limit,
        ),
        projects: bounded(
          members('project', currentProjectStates, ['completed']).map((record) =>
            projectItem(ownerId, record),
          ),
          options.limit,
        ),
        routines: bounded(
          members('routine', currentRoutineStates, []).map((record) =>
            linkedItem('routine', record),
          ),
          options.limit,
        ),
        reviewNote: null,
        history: listHistory(ownerId, axis.ref, options.limit),
      });
    },
    getOutcome(ownerId, id, limit) {
      const outcome = find(ownerId, 'outcome', id);
      if (outcome === null) return Promise.resolve(null);
      return Promise.resolve({
        outcome: outcomeItem(ownerId, outcome),
        milestones: bounded(
          live(referencing(ownerId, 'milestone', 'outcomeId', id)).map((record) =>
            milestoneItem(ownerId, record),
          ),
          limit,
        ),
        primaryProjects: bounded(
          live(referencing(ownerId, 'project', 'primaryOutcomeId', id)).map((record) =>
            projectItem(ownerId, record),
          ),
          limit,
        ),
        supportingProjects: bounded(
          linked(ownerId, 'outcome_secondary_project', 'parentId', id, 'project').map(
            ({ link, other }) => linkedItem('project', other, link),
          ),
          limit,
        ),
        history: listHistory(ownerId, outcome.ref, limit),
      });
    },
    getProject(ownerId, id, options) {
      const project = find(ownerId, 'project', id);
      if (project === null) return Promise.resolve(null);
      const document = project.document as ProjectDocument;
      return Promise.resolve({
        project: {
          ...projectItem(ownerId, project),
          ...(document.description === undefined ? {} : { description: document.description }),
          ...(document.notes === undefined ? {} : { notes: document.notes }),
        },
        secondaryOutcomes: linked(
          ownerId,
          'outcome_secondary_project',
          'childId',
          id,
          'outcome',
        ).map(({ link, other }) => linkedItem('outcome', other, link)),
        milestones: bounded(
          linked(ownerId, 'milestone_project', 'childId', id, 'milestone').map(({ link, other }) =>
            linkedItem('milestone', other, link),
          ),
          options.limit,
        ),
        actions: bounded(
          live(referencing(ownerId, 'action', 'projectId', id)).map((record) => ({
            ...linkedItem('action', record),
            orderKey: text(record.document['orderKey']) ?? '',
          })),
          options.actionLimit,
        ),
        capturedNotes: bounded(
          live(referencing(ownerId, 'note', 'projectId', id)).map((record) =>
            linkedItem('note', record),
          ),
          options.limit,
        ),
        history: listHistory(ownerId, project.ref, options.limit),
      });
    },
    getMilestone(ownerId, id, limit) {
      const milestone = find(ownerId, 'milestone', id);
      if (milestone === null) return Promise.resolve(null);
      const outcome = find(ownerId, 'outcome', milestone.document['outcomeId']);
      const axis = outcome === null ? null : find(ownerId, 'axis', outcome.document['axisId']);
      return Promise.resolve({
        milestone: milestoneItem(ownerId, milestone),
        ...(axis === null ? {} : { axis: nodeRef(axis) }),
        projects: bounded(
          linked(ownerId, 'milestone_project', 'parentId', id, 'project').map(({ link, other }) =>
            linkedItem('project', other, link),
          ),
          limit,
        ),
        actions: bounded(
          linked(ownerId, 'milestone_action', 'parentId', id, 'action').map(({ link, other }) =>
            linkedItem('action', other, link),
          ),
          limit,
        ),
        history: listHistory(ownerId, milestone.ref, limit),
      });
    },
    getNeighborhood(ownerId, focus, limit) {
      const record = find(ownerId, focus.kind, focus.id);
      if (record === null) return Promise.resolve(null);
      const document = record.document;
      const totals: Partial<Record<AlignmentRelationshipRule['relationship'], number>> = {};
      const below: AlignmentEdge[] = [];
      for (const rule of alignmentRelationshipsBelow(focus.kind)) {
        const edges = edgesFor(ownerId, rule, 'down', record);
        totals[rule.relationship] = edges.length;
        below.push(...edges.slice(0, clampLimit(limit)));
      }
      const target = (key: 'targetStart' | 'targetEnd') => {
        const value = text(document[key]);
        return value === undefined ? {} : { [key]: value };
      };
      return Promise.resolve({
        focus: {
          ...alignmentNode(focus.kind, record),
          ...(focus.kind === 'outcome' ? { progress: outcomeItem(ownerId, record).progress } : {}),
          ...target('targetStart'),
          ...target('targetEnd'),
        },
        chain: chainOf(ownerId, focus.kind, record),
        above: alignmentRelationshipsAbove(focus.kind).flatMap((rule) =>
          edgesFor(ownerId, rule, 'up', record),
        ),
        below,
        totals,
      });
    },
    listCandidates(ownerId, kind, search, limit) {
      const needle = search?.trim().toLocaleLowerCase('en-US') ?? '';
      const rows = live(all(ownerId, kind))
        .filter((record) => titleOf(record).toLocaleLowerCase('en-US').includes(needle))
        .sort(byOrder)
        .map((record) => {
          const axisId = text(record.document['axisId']);
          return {
            ...alignmentNode(kind, record),
            ...(axisId === undefined ? {} : { axisId: axisId as UUID }),
          };
        });
      return Promise.resolve(bounded(rows, limit));
    },
    listContainer(ownerId, scope) {
      const members = (type: EntityType, key: string, id: string | null) =>
        live(all(ownerId, type)).filter((record) => (text(record.document[key]) ?? null) === id);
      const rows = (() => {
        switch (scope.container) {
          case 'axes':
            return live(all(ownerId, 'axis'));
          case 'axis_outcomes':
            return members('outcome', 'axisId', scope.axisId);
          case 'axis_projects':
            return members('project', 'axisId', scope.axisId);
          case 'outcome_milestones':
            return members('milestone', 'outcomeId', scope.outcomeId);
          case 'project_actions':
            return members('action', 'projectId', scope.projectId);
        }
      })();
      return Promise.resolve(
        rows.map((record): AlignmentContainerRow => ({
          ref: record.ref,
          orderKey: text(record.document['orderKey']) ?? '',
          localRevision: record.localRevision,
          state: text(record.document['state']) ?? 'active',
        })),
      );
    },
    findLink(ownerId, relationship, parentId, childId) {
      const record = all(ownerId, alignmentLinkEntityType(relationship)).find((candidate) => {
        const endpoints = linkEndpoints(relationship, candidate.document);
        return endpoints?.parentId === parentId && endpoints.childId === childId;
      });
      return Promise.resolve(record ?? null);
    },
    getArchiveImpact(ownerId, ref) {
      const counts: Partial<Record<AlignmentNodeKind, number>> = {};
      const add = (kind: AlignmentNodeKind, amount: number) => {
        if (amount > 0) counts[kind] = (counts[kind] ?? 0) + amount;
      };
      const children = (type: EntityType, key: string) =>
        live(referencing(ownerId, type, key, ref.id)).length;
      const activeLinked = (
        relationship: AlignmentJoinRelationship,
        otherType: EntityType,
      ): number =>
        linked(ownerId, relationship, 'parentId', ref.id, otherType).filter(
          ({ other }) => !isArchived(other.document),
        ).length;
      const byTarget: Partial<Record<EntityType, () => void>> = {
        axis: () => {
          for (const type of ['outcome', 'project', 'routine', 'action', 'note'] as const)
            add(type, children(type, 'axisId'));
        },
        outcome: () => {
          add('milestone', children('milestone', 'outcomeId'));
          add('project', children('project', 'primaryOutcomeId'));
          add('project', activeLinked('outcome_secondary_project', 'project'));
        },
        project: () => {
          add('action', children('action', 'projectId'));
          add('note', children('note', 'projectId'));
        },
        milestone: () => {
          add('project', activeLinked('milestone_project', 'project'));
          add('action', activeLinked('milestone_action', 'action'));
        },
      };
      byTarget[ref.type]?.();
      return Promise.resolve(counts);
    },
    getDeleteImpact(ownerId, ref) {
      return Promise.resolve(deleteImpact(ownerId, ref));
    },
    listHistory(ownerId, ref, limit) {
      return Promise.resolve(listHistory(ownerId, ref, limit));
    },
  };
}

/* ───────────────────────── Fixture seeder ───────────────────────── */

export interface SeedOptions {
  readonly id?: UUID;
  readonly revision?: number;
}

/**
 * Seeds canonical records straight into the in-memory unit of work (fixtures only; no command,
 * event, or undo). Documents default to valid active objects and accept overrides.
 */
export interface AlignmentSeeder {
  axis(overrides?: Partial<AxisDocument>, options?: SeedOptions): CanonicalRecordState;
  outcome(overrides?: Partial<OutcomeDocument>, options?: SeedOptions): CanonicalRecordState;
  project(overrides?: Partial<ProjectDocument>, options?: SeedOptions): CanonicalRecordState;
  milestone(
    outcomeId: UUID,
    overrides?: Partial<MilestoneDocument>,
    options?: SeedOptions,
  ): CanonicalRecordState;
  action(overrides?: Partial<ActionCanonicalDocument>, options?: SeedOptions): CanonicalRecordState;
  note(overrides?: Partial<NoteDocument>, options?: SeedOptions): CanonicalRecordState;
  /** A minimal Routine document carrying only the fields alignment reads. */
  routine(
    overrides?: Readonly<Record<string, unknown>>,
    options?: SeedOptions,
  ): CanonicalRecordState;
  link(
    relationship: AlignmentJoinRelationship,
    parentId: UUID,
    childId: UUID,
    options?: { readonly unlinkedAt?: Instant; readonly revision?: number },
  ): CanonicalRecordState;
  placement(
    kind: AlignmentKind | 'action',
    targetId: UUID,
    period: HorizonPeriod,
    options?: { readonly archivedAt?: Instant },
  ): CanonicalRecordState;
  weekSelection(
    kind: 'action' | 'project' | 'milestone',
    targetId: UUID,
    options?: { readonly archivedAt?: Instant },
  ): CanonicalRecordState;
  /** A draft weekly review unless overridden (Review `ReviewDocument`). */
  review(overrides?: Partial<ReviewDocument>, options?: SeedOptions): CanonicalRecordState;
  /**
   * A review item naming the target: `note` for an Axis, `carry` for an Action, and
   * `continue` otherwise, in a new review unless `reviewId` is given.
   */
  reviewItem(
    target: {
      readonly kind: 'axis' | 'outcome' | 'project' | 'milestone' | 'action';
      readonly id: UUID;
    },
    overrides?: Partial<ReviewItemDocument>,
    options?: SeedOptions,
  ): CanonicalRecordState;
  routineDefaults(projectId: UUID): CanonicalRecordState;
}

export function createAlignmentSeeder(
  unitOfWork: InMemoryUnitOfWork,
  ownerId: OwnerId,
  idPrefix = 'f0000000-0000-4000-8000-',
): AlignmentSeeder {
  let sequence = 0;
  const nextId = (): UUID => {
    sequence += 1;
    return `${idPrefix}${String(sequence).padStart(12, '0')}` as UUID;
  };
  const seed = (
    type: EntityType,
    document: Doc,
    options: SeedOptions = {},
  ): CanonicalRecordState => {
    const record: CanonicalRecordState = {
      ref: createEntityRef(type, options.id ?? nextId(), ownerId),
      localRevision: options.revision ?? 1,
      serverRevision: 0,
      baseSnapshotHash: null,
      document,
    };
    unitOfWork.seed(record);
    return record;
  };
  const orderKey = () => spacedOrderKey(sequence);
  return {
    axis: (overrides = {}, options) =>
      seed(
        'axis',
        { title: 'Health', orderKey: orderKey(), state: 'active', ...overrides },
        options,
      ),
    outcome: (overrides = {}, options) =>
      seed(
        'outcome',
        {
          title: 'Run a 10k',
          successDefinition: 'Finish a 10k run',
          progress: { mode: 'none' },
          orderKey: orderKey(),
          state: 'active',
          ...overrides,
        },
        options,
      ),
    project: (overrides = {}, options) =>
      seed(
        'project',
        { title: 'Launch site', orderKey: orderKey(), state: 'idea', ...overrides },
        options,
      ),
    milestone: (outcomeId, overrides = {}, options) =>
      seed(
        'milestone',
        {
          title: 'First 5k',
          measurableCheckpoint: 'Run 5k without stopping',
          outcomeId,
          orderKey: orderKey(),
          state: 'active',
          ...overrides,
        },
        options,
      ),
    action: (overrides = {}, options) =>
      seed(
        'action',
        {
          title: 'Draft the plan',
          captureOrigin: 'plan',
          orderKey: orderKey(),
          state: 'planned',
          ...overrides,
        },
        options,
      ),
    note: (overrides = {}, options) =>
      seed('note', { title: 'Idea', orderKey: orderKey(), state: 'active', ...overrides }, options),
    routine: (overrides = {}, options) =>
      seed(
        'routine',
        {
          title: 'Morning walk',
          orderKey: orderKey(),
          state: 'active',
          generations: [],
          ...overrides,
        },
        options,
      ),
    link: (relationship, parentId, childId, options = {}) => {
      const ref = linkRef(ownerId, relationship, parentId, childId);
      return seed(
        ref.type,
        {
          ...linkDocument(relationship, parentId, childId),
          ...(options.unlinkedAt === undefined ? {} : { unlinkedAt: options.unlinkedAt }),
        },
        { id: ref.id, ...(options.revision === undefined ? {} : { revision: options.revision }) },
      );
    },
    placement: (kind, targetId, period, options = {}) =>
      seed('planning_placement', {
        target: { kind, [`${kind}Id`]: targetId },
        period,
        orderKey: orderKey(),
        ...(options.archivedAt === undefined ? {} : { archivedAt: options.archivedAt }),
      }),
    weekSelection: (kind, targetId, options = {}) =>
      seed('focus_selection', {
        kind: 'week_commitment',
        profileId: nextId(),
        target: { kind, [`${kind}Id`]: targetId },
        periodStart: '2026-09-28',
        periodEnd: '2026-10-04',
        weekStart: 'monday',
        orderKey: orderKey(),
        ...(options.archivedAt === undefined ? {} : { archivedAt: options.archivedAt }),
      }),
    review: (overrides = {}, options) =>
      seed(
        'review',
        {
          profileId: nextId(),
          reviewType: 'weekly',
          periodKey: '2026-09-21',
          periodStart: '2026-09-21',
          periodEnd: '2026-09-27',
          weekStart: 'monday',
          state: 'draft',
          ...overrides,
        },
        options,
      ),
    reviewItem: (target, overrides = {}, options) =>
      seed(
        'review_item',
        {
          reviewId: nextId(),
          target: { kind: target.kind, [`${target.kind}Id`]: target.id },
          ...(target.kind === 'axis'
            ? { decision: 'note', note: 'What helped' }
            : { decision: target.kind === 'action' ? 'carry' : 'continue' }),
          orderKey: orderKey(),
          ...overrides,
        },
        options,
      ),
    routineDefaults: (projectId) =>
      seed('routine_action_defaults', { routineId: nextId(), generation: 1, projectId }),
  };
}
