import {
  createEntityRef,
  createWeekPeriod,
  daysBetween,
  err,
  localDateOf,
  localRangeBounds,
  localWallTimeOf,
  ok,
  parseCalendarDate,
  parseTemplateBlueprint,
  parseUUID,
  previewTemplateApplication,
  restoreLifecycle,
  templateLimits,
  transitionLifecycle,
  validateTemplateSnapshot,
  type CalendarDate,
  type CommandContext,
  type DomainChange,
  type DomainResult,
  type EntityRef,
  type Instant,
  type OwnerId,
  type TemplateBlueprint,
  type TemplateBlueprintItemV2,
  type UUID,
  type WallTime,
} from '@yelaxis/domain';

import type { ActionCanonicalDocument } from './actions';
import type { ApplicationResult, CanonicalMutation, CommandReceipt } from './contracts';
import { executeCommand } from './execute-command';
import type { BlockRow, PlanningQueryPort, TemplateDocument } from './planning-contracts';
import type { TemplateMethods } from './planning';
import {
  createMutation,
  domainFailure,
  invalid,
  notFound,
  planningChange,
  updateFrom,
  without,
} from './planning-kit';
import {
  rejected,
  resolveOwner,
  snapshotMetadata,
  transitionError,
  userEnvelope,
} from './planning-routines-support';
import {
  acknowledgeOverlaps,
  createSchedulingKit,
  overlapRejection,
} from './planning-scheduling-support';
import { planTemplateApplication, scanTemplateOverlaps } from './planning-templates-apply';
import type { ApplicationDependencies } from './ports';
import { findBuiltInTemplate } from './template-catalog';

const templateRef = (ownerId: OwnerId, id: UUID): EntityRef<'template'> =>
  createEntityRef('template', id, ownerId);

function templateTitle(value: string): DomainResult<string> {
  const title = value.trim();
  if (title.length === 0 || title.length > 200)
    return invalid('title', 'Enter a template name up to 200 characters.');
  return ok(title);
}

function validateTemplateDocument(
  ref: EntityRef<'template'>,
  document: TemplateDocument,
  now: Instant,
): DomainResult<TemplateDocument> {
  const checked = validateTemplateSnapshot({
    ...snapshotMetadata(ref.id, ref.ownerId, now),
    title: document.title,
    blueprint: document.blueprint,
    state: document.state,
    ...(document.stateBeforeArchive === undefined
      ? {}
      : { stateBeforeArchive: document.stateBeforeArchive }),
  });
  return checked.ok ? ok(document) : checked;
}

function createTemplateChange(
  ref: EntityRef<'template'>,
  document: TemplateDocument,
  context: CommandContext,
  eventType: string,
): DomainResult<DomainChange<readonly CanonicalMutation[]>> {
  const valid = validateTemplateDocument(ref, document, context.now);
  if (!valid.ok) return valid;
  return ok(
    planningChange([createMutation(ref, document)], context, eventType, {
      created: [{ ref, kind: 'template' }],
    }),
  );
}

const builtInReadOnly = (): ApplicationResult<never> =>
  rejected(
    'built_in_read_only',
    {},
    'Starter templates cannot be changed. Duplicate it to make your own copy.',
  );

const minutesBetween = (startsAt: Instant, endsAt: Instant): number =>
  Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000);

interface WeekItemCandidate {
  readonly actionId: UUID;
  readonly offset: number;
  readonly orderKey: string;
  readonly localStartTime?: WallTime;
  readonly durationMinutes?: number;
}

export function createTemplateCommands(
  dependencies: ApplicationDependencies,
  queries: PlanningQueryPort,
): TemplateMethods {
  const kit = createSchedulingKit(dependencies, queries);
  /** Blueprint of a built-in or user template, re-validated before any use. */
  const loadBlueprint = async (
    ownerId: OwnerId,
    templateId: string,
    options: { readonly allowArchived: boolean },
  ): Promise<ApplicationResult<TemplateBlueprint>> => {
    const builtIn = findBuiltInTemplate(templateId);
    const raw: unknown = builtIn?.blueprint;
    if (builtIn !== undefined) {
      const parsed = parseTemplateBlueprint(raw);
      return parsed.ok ? { ok: true, value: parsed.value } : domainFailure(parsed);
    }
    const id = parseUUID(templateId);
    if (!id.ok) return domainFailure(id);
    const row = await queries.getTemplate(ownerId, id.value);
    if (row === null) return notFound(templateRef(ownerId, id.value));
    if (!options.allowArchived && row.document.state === 'archived')
      return rejected('template_archived', {}, 'Restore this template before using it.');
    const parsed = parseTemplateBlueprint(row.document.blueprint);
    return parsed.ok ? { ok: true, value: parsed.value } : domainFailure(parsed);
  };

  /** Archive or restore a user template; built-in templates are application code. */
  const setArchived = async (
    input: { readonly templateId: string; readonly revision: number },
    archived: boolean,
    commandId: Parameters<TemplateMethods['archiveTemplate']>[1],
  ): Promise<ApplicationResult<CommandReceipt>> => {
    const owner = await resolveOwner(dependencies);
    if (!owner.ok) return owner;
    const ownerId = owner.value;
    if (findBuiltInTemplate(input.templateId) !== undefined) return builtInReadOnly();
    const id = parseUUID(input.templateId);
    if (!id.ok) return domainFailure(id);
    const ref = templateRef(ownerId, id.value);
    if ((await queries.readRecord(ownerId, ref)) === null) return notFound(ref);
    return executeCommand(
      dependencies,
      userEnvelope(dependencies, ownerId, commandId, [{ ref, revision: input.revision }], { ref }),
      async ({ input: request, records, context }) => {
        const current = await records.read(request.ref);
        if (current === null)
          return err({ code: 'invalid_value', message: 'The template no longer exists.' });
        const document = current.document as TemplateDocument;
        let next: TemplateDocument;
        if (archived) {
          const transition = transitionLifecycle({
            entityType: 'template',
            current: { state: document.state },
            to: 'archived',
          });
          if (!transition.ok) return transition;
          next = {
            ...document,
            state: 'archived',
            stateBeforeArchive: 'active',
            archivedAt: context.now,
          };
        } else {
          if (document.state !== 'archived')
            return transitionError(
              'template_not_archived',
              'Only an archived template can be restored.',
            );
          const restored = restoreLifecycle('template', { state: document.state });
          if (!restored.ok) return restored;
          next = {
            ...without(without(document, 'stateBeforeArchive'), 'archivedAt'),
            state: 'active',
          };
        }
        const valid = validateTemplateDocument(request.ref, next, context.now);
        if (!valid.ok) return valid;
        return ok(
          planningChange(
            [updateFrom(current, next)],
            context,
            archived ? 'template.archived' : 'template.restored',
            { prior: [current] },
          ),
        );
      },
    );
  };

  return {
    async applyTemplate(input, commandId) {
      const owner = await resolveOwner(dependencies);
      if (!owner.ok) return owner;
      const ownerId = owner.value;
      const blueprint = await loadBlueprint(ownerId, input.templateId, { allowArchived: false });
      if (!blueprint.ok) return blueprint;
      const preview = previewTemplateApplication(blueprint.value, {
        anchorDate: input.anchorDate,
        timeZone: input.timeZone,
        selectedKeys: new Set(input.selectedKeys),
      });
      if (!preview.ok) return domainFailure(preview);
      if (preview.value.issues.length > 0)
        return rejected(
          'template_preview_issues',
          { issues: preview.value.issues },
          'Some selected items need attention before this template can be applied.',
        );
      const profile = await queries.getPlanProfile(ownerId);
      const overlaps = await scanTemplateOverlaps(
        queries,
        ownerId,
        profile.planningTimeZone,
        preview.value,
      );
      const keepOverlaps = input.overlapAcknowledged === true;
      const plan = planTemplateApplication({
        preview: preview.value,
        ownerId,
        weekStart: profile.weekStart,
        nextId: () => dependencies.ids.next(),
        now: dependencies.clock.now(),
        acknowledgedKeys: new Set(
          keepOverlaps ? overlaps.items.map((item) => item.templateKey) : [],
        ),
      });
      if (!plan.ok) return domainFailure(plan);
      return kit.run(
        ownerId,
        commandId,
        'template.applied',
        overlaps.expected,
        async ({ records }) => {
          if (overlaps.keys.length > 0 && !keepOverlaps) return overlapRejection(overlaps.keys);
          const acknowledged = await acknowledgeOverlaps(records, ownerId, overlaps.targets);
          if (!acknowledged.ok) return acknowledged;
          return ok({
            mutations: [...plan.value.mutations, ...acknowledged.value.mutations],
            created: [...plan.value.created, ...acknowledged.value.created],
          });
        },
      );
    },

    async duplicateTemplate(input, commandId) {
      const owner = await resolveOwner(dependencies);
      if (!owner.ok) return owner;
      const ownerId = owner.value;
      const title = templateTitle(input.title);
      if (!title.ok) return domainFailure(title);
      const blueprint = await loadBlueprint(ownerId, input.templateId, { allowArchived: true });
      if (!blueprint.ok) return blueprint;
      const ref = templateRef(ownerId, dependencies.ids.next());
      const document: TemplateDocument = {
        title: title.value,
        blueprint: blueprint.value,
        state: 'active',
      };
      return executeCommand(
        dependencies,
        userEnvelope(dependencies, ownerId, commandId, [], { ref, document }),
        ({ input: request, context }) =>
          createTemplateChange(request.ref, request.document, context, 'template.duplicated'),
      );
    },

    async saveTemplate(input, commandId) {
      const owner = await resolveOwner(dependencies);
      if (!owner.ok) return owner;
      const ownerId = owner.value;
      if (input.templateId !== undefined && findBuiltInTemplate(input.templateId) !== undefined)
        return builtInReadOnly();
      const title = templateTitle(input.title);
      if (!title.ok) return domainFailure(title);
      const blueprint = parseTemplateBlueprint(input.blueprint);
      if (!blueprint.ok) return domainFailure(blueprint);
      if (input.templateId === undefined || input.templateId === '') {
        const ref = templateRef(ownerId, dependencies.ids.next());
        const document: TemplateDocument = {
          title: title.value,
          blueprint: blueprint.value,
          state: 'active',
        };
        return executeCommand(
          dependencies,
          userEnvelope(dependencies, ownerId, commandId, [], { ref, document }),
          ({ input: request, context }) =>
            createTemplateChange(request.ref, request.document, context, 'template.created'),
        );
      }
      const id = parseUUID(input.templateId);
      if (!id.ok) return domainFailure(id);
      if (input.revision === undefined)
        return rejected('revision_required', {}, 'Reload the template and try again.');
      const ref = templateRef(ownerId, id.value);
      if ((await queries.readRecord(ownerId, ref)) === null) return notFound(ref);
      return executeCommand(
        dependencies,
        userEnvelope(dependencies, ownerId, commandId, [{ ref, revision: input.revision }], {
          ref,
        }),
        async ({ input: request, records, context }) => {
          const current = await records.read(request.ref);
          if (current === null)
            return err({ code: 'invalid_value', message: 'The template no longer exists.' });
          const document = current.document as TemplateDocument;
          if (document.state === 'archived')
            return transitionError('template_archived', 'Restore this template before editing it.');
          const next: TemplateDocument = {
            ...document,
            title: title.value,
            blueprint: blueprint.value,
          };
          const valid = validateTemplateDocument(request.ref, next, context.now);
          if (!valid.ok) return valid;
          return ok(
            planningChange([updateFrom(current, next)], context, 'template.edited', {
              prior: [current],
            }),
          );
        },
      );
    },

    archiveTemplate(input, commandId) {
      return setArchived(input, true, commandId);
    },

    restoreTemplate(input, commandId) {
      return setArchived(input, false, commandId);
    },

    async saveWeekAsTemplate(input, commandId) {
      const owner = await resolveOwner(dependencies);
      if (!owner.ok) return owner;
      const ownerId = owner.value;
      const title = templateTitle(input.title);
      if (!title.ok) return domainFailure(title);
      const date = parseCalendarDate(input.weekDate);
      if (!date.ok) return domainFailure(date);
      const profile = await queries.getPlanProfile(ownerId);
      const zone = profile.planningTimeZone;
      const week = createWeekPeriod(date.value, profile.weekStart);
      const inWeek = (value: CalendarDate): boolean => value >= week.start && value <= week.end;

      // Structure only: Day-placed and scheduled Actions with their day offset and local time.
      const placements = await queries.listPlacements(ownerId, {
        start: week.start,
        end: week.end,
      });
      const bounds = localRangeBounds({ start: week.start, end: week.end }, zone);
      const blocks = await queries.listBlocks(ownerId, bounds.startsAt, bounds.endsAt);
      const blockByAction = new Map<UUID, BlockRow>();
      for (const block of [...blocks].sort((left, right) =>
        left.startsAt.localeCompare(right.startsAt),
      )) {
        if (block.state !== 'planned' || block.target.kind !== 'action') continue;
        if (!inWeek(localDateOf(block.startsAt, zone))) continue;
        if (!blockByAction.has(block.target.actionId))
          blockByAction.set(block.target.actionId, block);
      }
      const candidates = new Map<UUID, WeekItemCandidate>();
      const timing = (block: BlockRow | undefined) =>
        block === undefined
          ? {}
          : {
              localStartTime: localWallTimeOf(block.startsAt, zone),
              durationMinutes: Math.min(
                templateLimits.durationMinutes,
                Math.max(
                  templateLimits.minDurationMinutes,
                  minutesBetween(block.startsAt, block.endsAt),
                ),
              ),
            };
      for (const placement of placements) {
        if (placement.target.kind !== 'action' || placement.period.kind !== 'day') continue;
        if (!inWeek(placement.period.date)) continue;
        const actionId = placement.target.action.id;
        const block = blockByAction.get(actionId);
        const day = block === undefined ? placement.period.date : localDateOf(block.startsAt, zone);
        candidates.set(actionId, {
          actionId,
          offset: daysBetween(week.start, day),
          orderKey: placement.orderKey,
          ...timing(block),
        });
      }
      for (const [actionId, block] of blockByAction) {
        if (candidates.has(actionId)) continue;
        candidates.set(actionId, {
          actionId,
          offset: daysBetween(week.start, localDateOf(block.startsAt, zone)),
          orderKey: '',
          ...timing(block),
        });
      }

      const ordered = [...candidates.values()].sort(
        (left, right) =>
          left.offset - right.offset ||
          (left.localStartTime ?? '99:99').localeCompare(right.localStartTime ?? '99:99') ||
          left.orderKey.localeCompare(right.orderKey) ||
          left.actionId.localeCompare(right.actionId),
      );
      const items: TemplateBlueprintItemV2[] = [];
      for (const candidate of ordered) {
        const record = await queries.readRecord(
          ownerId,
          createEntityRef('action', candidate.actionId, ownerId),
        );
        if (record === null) continue;
        const action = record.document as ActionCanonicalDocument;
        if (action.state === 'canceled' || action.state === 'archived') continue;
        items.push({
          templateKey: `action-${items.length + 1}`,
          kind: 'action',
          title: action.title,
          ...(action.note === undefined ? {} : { note: action.note }),
          ...(action.estimateMinutes === undefined
            ? {}
            : { estimateMinutes: action.estimateMinutes }),
          ...(action.energy === undefined ? {} : { energy: action.energy }),
          ...(action.priority === undefined ? {} : { priority: action.priority }),
          relativeDayOffset: candidate.offset,
          ...(candidate.localStartTime === undefined
            ? {}
            : {
                localStartTime: candidate.localStartTime,
                ...(candidate.durationMinutes === undefined
                  ? {}
                  : { durationMinutes: candidate.durationMinutes }),
              }),
        });
      }
      if (items.length === 0)
        return rejected('nothing_to_save', {}, 'This week has no planned Actions to save.');
      if (items.length > templateLimits.items)
        return rejected('too_many_items', {}, 'A template can hold up to 50 items.');
      const blueprint = parseTemplateBlueprint({ version: 2, items });
      if (!blueprint.ok) return domainFailure(blueprint);
      const ref = templateRef(ownerId, dependencies.ids.next());
      const document: TemplateDocument = {
        title: title.value,
        blueprint: blueprint.value,
        state: 'active',
      };
      return executeCommand(
        dependencies,
        userEnvelope(dependencies, ownerId, commandId, [], { ref, document }),
        ({ input: request, context }) =>
          createTemplateChange(request.ref, request.document, context, 'template.saved_from_week'),
      );
    },
  };
}
