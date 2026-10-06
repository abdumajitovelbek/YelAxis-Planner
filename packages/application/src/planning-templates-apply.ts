import {
  createDayPeriod,
  createEntityRef,
  createMonthPeriod,
  createWeekPeriod,
  intervalsIntersect,
  localDateOf,
  ok,
  validateNoteSnapshot,
  validateOutcomeSnapshot,
  validateProjectSnapshot,
  validateTimeBlockInterval,
  type DomainResult,
  type EntityType,
  type HorizonPeriod,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type TemplateItemKind,
  type TemplateItemSchedule,
  type TemplatePreview,
  type TemplatePreviewItem,
  type UUID,
  type Weekday,
} from '@yelaxis/domain';

import type { ActionCanonicalDocument } from './actions';
import type { CanonicalMutation, ExpectedRevision } from './contracts';
import type {
  AxisDocument,
  CommitmentDocument,
  MilestoneDocument,
  NoteDocument,
  OutcomeDocument,
  PlacementTargetDocument,
  PlanningPlacementDocument,
  PlanningQueryPort,
  ProjectDocument,
  TemplateItemOverlaps,
  TemplateOverlapView,
  TimeBlockDocument,
  TimeBlockTargetDocument,
} from './planning-contracts';
import { createMutation, invalid, type CreatedKind, type CreatedRecord } from './planning-kit';
import { createOrderKeySequence, snapshotMetadata } from './planning-routines-support';
import { scanOverlaps, type AcknowledgementTarget } from './planning-scheduling-support';

export interface TemplateApplicationPlan {
  readonly mutations: readonly CanonicalMutation[];
  readonly created: readonly CreatedRecord[];
}

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
};

/** Parent depth so every parent record is created before the records that reference it. */
function depthOf(
  item: TemplatePreviewItem,
  byKey: ReadonlyMap<string, TemplatePreviewItem>,
): number {
  let depth = 0;
  let current = item;
  const seen = new Set<string>([item.templateKey]);
  while (current.parentTemplateKey !== undefined) {
    const parent = byKey.get(current.parentTemplateKey);
    if (parent === undefined || seen.has(parent.templateKey)) break;
    seen.add(parent.templateKey);
    depth += 1;
    current = parent;
  }
  return depth;
}

type TimedSchedule = Extract<TemplateItemSchedule, { kind: 'timed' }>;

/** Key of another selected template item in overlap details: `template:<templateKey>`. */
export const templateItemKey = (templateKey: string): string => `template:${templateKey}`;

export interface TemplateOverlapScan {
  /** Per selected timed item, everything its exact time would overlap. */
  readonly items: readonly TemplateItemOverlaps[];
  /** Every overlapped key, for the rejection details. */
  readonly keys: readonly string[];
  /** Existing planned items to acknowledge when the user keeps the overlaps. */
  readonly targets: readonly AcknowledgementTarget[];
  readonly expected: readonly ExpectedRevision[];
}

/**
 * The same overlap scan the scheduling commands use, run for each selected timed item against
 * planned work, plus overlaps among the template's own selected timed items. Only reports.
 */
export async function scanTemplateOverlaps(
  queries: PlanningQueryPort,
  ownerId: OwnerId,
  planningTimeZone: IanaTimeZone,
  preview: TemplatePreview,
): Promise<TemplateOverlapScan> {
  const timed = preview.items.flatMap((item) =>
    item.selected && item.schedule.kind === 'timed' ? [{ item, schedule: item.schedule }] : [],
  );
  const items: TemplateItemOverlaps[] = [];
  const keys = new Set<string>();
  const targets = new Map<string, AcknowledgementTarget>();
  const expected: ExpectedRevision[] = [];
  for (const { item, schedule } of timed) {
    // Sequential: the browser owns one SQLite worker connection.
    const scan = await scanOverlaps(queries, ownerId, planningTimeZone, schedule);
    const overlaps: TemplateOverlapView[] = [...scan.items];
    for (const other of timed) {
      if (other.item.templateKey === item.templateKey) continue;
      if (intervalsIntersect(schedule, other.schedule))
        overlaps.push({ key: templateItemKey(other.item.templateKey), title: other.item.title });
    }
    if (overlaps.length === 0) continue;
    items.push({ templateKey: item.templateKey, overlaps });
    for (const overlap of overlaps) keys.add(overlap.key);
    for (const target of scan.targets) {
      // Two template items can overlap the same planned item; acknowledge it once.
      const key = JSON.stringify(target.kind === 'block' ? target.ref : target.target);
      if (!targets.has(key)) targets.set(key, target);
    }
    expected.push(...scan.expected);
  }
  return { items, keys: [...keys], targets: [...targets.values()], expected };
}

/**
 * Turn a validated, issue-free preview into create mutations. Only selected items become records;
 * parents map to typed fields only. A new block is marked acknowledged only when its template key
 * is in `acknowledgedKeys`, which carries the user's explicit Keep-overlap choice.
 */
export function planTemplateApplication(input: {
  readonly preview: TemplatePreview;
  readonly ownerId: OwnerId;
  readonly weekStart: Weekday;
  readonly nextId: () => UUID;
  readonly now: Instant;
  readonly acknowledgedKeys?: ReadonlySet<string>;
}): DomainResult<TemplateApplicationPlan> {
  const { preview, ownerId, weekStart, nextId, now } = input;
  const acknowledgedKeys = input.acknowledgedKeys ?? new Set<string>();
  const byKey = new Map(preview.items.map((item) => [item.templateKey, item]));
  const ordered = preview.items
    .map((item, index) => ({ item, index, depth: depthOf(item, byKey) }))
    .filter(({ item }) => item.selected)
    .sort((left, right) => left.depth - right.depth || left.index - right.index)
    .map(({ item }) => item);
  const orderKey = createOrderKeySequence();
  const mutations: CanonicalMutation[] = [];
  const created: CreatedRecord[] = [];
  const createdByKey = new Map<string, { readonly kind: TemplateItemKind; readonly id: UUID }>();

  const create = (
    type: EntityType & CreatedKind,
    document: Readonly<Record<string, unknown>>,
    id: UUID = nextId(),
  ): UUID => {
    const ref = createEntityRef(type, id, ownerId);
    mutations.push(createMutation(ref, document));
    created.push({ ref, kind: type });
    return id;
  };
  const place = (target: PlacementTargetDocument, period: HorizonPeriod): void => {
    const document: PlanningPlacementDocument = { target, period, orderKey: orderKey() };
    create('planning_placement', document);
  };
  const block = (
    target: TimeBlockTargetDocument,
    schedule: TimedSchedule,
    templateKey: string,
  ): DomainResult<null> => {
    // The same interval rules as every other block path (at least 5 minutes, at most one day).
    const interval = validateTimeBlockInterval(
      schedule.startsAt,
      schedule.endsAt,
      preview.timeZone,
    );
    if (!interval.ok) return interval;
    const document: TimeBlockDocument = {
      target,
      startsAt: interval.value.startsAt,
      endsAt: interval.value.endsAt,
      timeZone: preview.timeZone,
      state: 'planned',
      overlapAcknowledged: acknowledgedKeys.has(templateKey),
    };
    create('time_block', document);
    return ok(null);
  };
  const datedPeriod = (
    schedule: TemplateItemSchedule,
    horizon: 'week' | 'month',
  ): HorizonPeriod | undefined => {
    if (schedule.kind === 'unscheduled') return undefined;
    return horizon === 'week'
      ? createWeekPeriod(schedule.date, weekStart)
      : createMonthPeriod(schedule.date);
  };

  for (const item of ordered) {
    const parent =
      item.parentTemplateKey === undefined ? undefined : createdByKey.get(item.parentTemplateKey);
    if (item.parentTemplateKey !== undefined && parent === undefined)
      return invalid('parent_deselected', 'Select the parent item too.');
    const parentAxis = parent?.kind === 'axis' ? parent.id : undefined;
    const parentProject = parent?.kind === 'project' ? parent.id : undefined;
    const parentOutcome = parent?.kind === 'outcome' ? parent.id : undefined;
    const note = trimmed(item.note);
    const id = nextId();
    switch (item.kind) {
      case 'axis': {
        const document: AxisDocument = {
          title: item.title,
          ...(note === undefined ? {} : { purpose: note }),
          orderKey: orderKey(),
          state: 'active',
        };
        create('axis', document, id);
        break;
      }
      case 'outcome': {
        if (note === undefined) return invalid('success_definition_required');
        const document: OutcomeDocument = {
          title: item.title,
          successDefinition: note,
          ...(parentAxis === undefined ? {} : { axisId: parentAxis }),
          progress: { mode: 'none' },
          orderKey: orderKey(),
          state: 'active',
        };
        const checked = validateOutcomeSnapshot({
          ...snapshotMetadata(id, ownerId, now),
          ...document,
        });
        if (!checked.ok) return checked;
        create('outcome', document, id);
        const period = datedPeriod(item.schedule, 'month');
        if (period !== undefined) place({ kind: 'outcome', outcomeId: id }, period);
        break;
      }
      case 'milestone': {
        if (note === undefined) return invalid('checkpoint_required');
        if (parentOutcome === undefined) return invalid('milestone_requires_outcome');
        const document: MilestoneDocument = {
          title: item.title,
          measurableCheckpoint: note,
          outcomeId: parentOutcome,
          orderKey: orderKey(),
          state: 'active',
        };
        create('milestone', document, id);
        const period = datedPeriod(item.schedule, 'week');
        if (period !== undefined) place({ kind: 'milestone', milestoneId: id }, period);
        break;
      }
      case 'project': {
        const document: ProjectDocument = {
          title: item.title,
          ...(note === undefined ? {} : { desiredResult: note }),
          ...(parentAxis === undefined ? {} : { axisId: parentAxis }),
          ...(parentOutcome === undefined ? {} : { primaryOutcomeId: parentOutcome }),
          orderKey: orderKey(),
          state: note === undefined ? 'idea' : 'active',
        };
        const checked = validateProjectSnapshot({
          ...snapshotMetadata(id, ownerId, now),
          ...document,
        });
        if (!checked.ok) return checked;
        create('project', document, id);
        const period = datedPeriod(item.schedule, 'week');
        if (period !== undefined) place({ kind: 'project', projectId: id }, period);
        break;
      }
      case 'action': {
        const schedule = item.schedule;
        const document: ActionCanonicalDocument = {
          title: item.title,
          captureOrigin: 'plan',
          ...(note === undefined ? {} : { note }),
          ...(parentProject === undefined ? {} : { projectId: parentProject }),
          ...(parentAxis === undefined ? {} : { axisId: parentAxis }),
          ...(item.estimateMinutes === undefined ? {} : { estimateMinutes: item.estimateMinutes }),
          ...(item.energy === undefined ? {} : { energy: item.energy }),
          ...(item.priority === undefined ? {} : { priority: item.priority }),
          orderKey: orderKey(),
          state: schedule.kind === 'timed' ? 'scheduled' : 'planned',
        };
        create('action', document, id);
        if (schedule.kind === 'date') {
          place({ kind: 'action', actionId: id }, createDayPeriod(schedule.date));
        } else if (schedule.kind === 'timed') {
          place(
            { kind: 'action', actionId: id },
            createDayPeriod(localDateOf(schedule.startsAt, preview.timeZone)),
          );
          const made = block({ kind: 'action', actionId: id }, schedule, item.templateKey);
          if (!made.ok) return made;
        }
        break;
      }
      case 'note': {
        const document: NoteDocument = {
          title: item.title,
          ...(note === undefined ? {} : { body: note }),
          ...(parentProject === undefined ? {} : { projectId: parentProject }),
          ...(parentAxis === undefined ? {} : { axisId: parentAxis }),
          orderKey: orderKey(),
          state: 'active',
        };
        const checked = validateNoteSnapshot({
          ...snapshotMetadata(id, ownerId, now),
          ...document,
        });
        if (!checked.ok) return checked;
        create('note', document, id);
        break;
      }
      case 'commitment': {
        const schedule = item.schedule;
        if (schedule.kind !== 'timed') return invalid('commitment_time_required');
        const document: CommitmentDocument = {
          title: item.title,
          strength: 'soft',
          state: 'planned',
        };
        create('commitment', document, id);
        const made = block({ kind: 'commitment', commitmentId: id }, schedule, item.templateKey);
        if (!made.ok) return made;
        break;
      }
      case 'routine':
        return invalid('unsupported_kind', 'Routine items cannot be applied from a template.');
    }
    createdByKey.set(item.templateKey, { kind: item.kind, id });
  }
  if (mutations.length === 0) return invalid('nothing_selected');
  return ok({ mutations, created });
}
