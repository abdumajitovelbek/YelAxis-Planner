import { err, ok, type DomainResult, type Instant } from './contracts.js';
import {
  energyLabels,
  type EnergyLabel,
  type Priority,
  type TemplateBlueprint,
  type TemplateBlueprintItemV1,
  type TemplateBlueprintItemV2,
  type TemplateItemKind,
} from './entities.js';
import { addDays, resolveLocalInterval } from './horizons.js';
import { MIN_BLOCK_MINUTES } from './time-blocks.js';
import {
  parseCalendarDate,
  parseIanaTimeZone,
  parseWallTime,
  type CalendarDate,
  type IanaTimeZone,
  type WallTime,
} from './time.js';

export const templateLimits = Object.freeze({
  items: 50,
  templateKey: 50,
  title: 200,
  note: 10_000,
  estimateMinutes: 10_080,
  dayOffset: 365,
  /** A timed item becomes a Time Block, so it shares the block duration range. */
  minDurationMinutes: MIN_BLOCK_MINUTES,
  durationMinutes: 1_440,
});

export const templateItemKinds: readonly TemplateItemKind[] = [
  'axis',
  'outcome',
  'milestone',
  'project',
  'action',
  'note',
  'routine',
  'commitment',
];

/** Typed parent relationships a template item may express; all others are rejected. */
export const templateParentKinds: Readonly<Record<TemplateItemKind, readonly TemplateItemKind[]>> =
  {
    axis: [],
    outcome: ['axis'],
    milestone: ['outcome'],
    project: ['axis', 'outcome'],
    action: ['project', 'axis'],
    note: ['project', 'axis'],
    routine: ['axis'],
    commitment: [],
  };

/** Kinds whose relative day can become a Planning Placement or exact block. */
const placeableKinds: readonly TemplateItemKind[] = [
  'outcome',
  'milestone',
  'project',
  'action',
  'commitment',
];
const timedKinds: readonly TemplateItemKind[] = ['action', 'commitment'];

const priorities: readonly Priority[] = ['low', 'normal', 'high'];

const templateError = (reason: string, templateKey?: string): DomainResult<never> =>
  err({
    code: 'invalid_value',
    message: 'The template blueprint is invalid.',
    details: templateKey === undefined ? { reason } : { reason, templateKey },
  });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const v1Keys = [
  'templateKey',
  'kind',
  'parentTemplateKey',
  'title',
  'note',
  'estimateMinutes',
  'energy',
  'priority',
];
const v2Keys = [...v1Keys, 'relativeDayOffset', 'localStartTime', 'durationMinutes'];

const parseItem = (
  value: unknown,
  version: 1 | 2,
): DomainResult<TemplateBlueprintItemV1 | TemplateBlueprintItemV2> => {
  if (!isRecord(value)) return templateError('item_shape');
  const key = value['templateKey'];
  if (typeof key !== 'string' || key.trim().length === 0 || key.length > templateLimits.templateKey)
    return templateError('template_key');
  const allowed = version === 1 ? v1Keys : v2Keys;
  if (Object.keys(value).some((name) => !allowed.includes(name)))
    return templateError('unknown_field', key);
  const kind = value['kind'];
  if (typeof kind !== 'string' || !templateItemKinds.includes(kind as TemplateItemKind))
    return templateError('kind', key);
  const title = value['title'];
  if (
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    title.trim().length > templateLimits.title
  )
    return templateError('title', key);
  const parent = value['parentTemplateKey'];
  if (parent !== undefined && (typeof parent !== 'string' || parent.trim().length === 0))
    return templateError('parent', key);
  const note = value['note'];
  if (note !== undefined && (typeof note !== 'string' || note.length > templateLimits.note))
    return templateError('note', key);
  const estimate = value['estimateMinutes'];
  if (
    estimate !== undefined &&
    (typeof estimate !== 'number' ||
      !Number.isInteger(estimate) ||
      estimate < 1 ||
      estimate > templateLimits.estimateMinutes)
  )
    return templateError('estimate_minutes', key);
  const energy = value['energy'];
  if (energy !== undefined && !energyLabels.includes(energy as EnergyLabel))
    return templateError('energy', key);
  const priority = value['priority'];
  if (priority !== undefined && !priorities.includes(priority as Priority))
    return templateError('priority', key);

  const base: TemplateBlueprintItemV1 = {
    templateKey: key,
    kind: kind as TemplateItemKind,
    title: title.trim(),
    ...(parent === undefined ? {} : { parentTemplateKey: parent }),
    ...(note === undefined || note.trim().length === 0 ? {} : { note }),
    ...(estimate === undefined ? {} : { estimateMinutes: estimate }),
    ...(energy === undefined ? {} : { energy: energy as EnergyLabel }),
    ...(priority === undefined ? {} : { priority: priority as Priority }),
  };
  if (version === 1) return ok(base);

  const offset = value['relativeDayOffset'];
  const start = value['localStartTime'];
  const duration = value['durationMinutes'];
  if (
    offset !== undefined &&
    (typeof offset !== 'number' ||
      !Number.isInteger(offset) ||
      Math.abs(offset) > templateLimits.dayOffset)
  )
    return templateError('relative_day_offset', key);
  let wallTime: WallTime | undefined;
  if (start !== undefined) {
    if (typeof start !== 'string' || !/^\d{2}:\d{2}$/u.test(start))
      return templateError('local_start_time', key);
    const parsed = parseWallTime(start);
    if (!parsed.ok) return templateError('local_start_time', key);
    if (offset === undefined) return templateError('local_start_time_requires_offset', key);
    wallTime = parsed.value;
  }
  if (
    duration !== undefined &&
    (typeof duration !== 'number' ||
      !Number.isInteger(duration) ||
      duration < templateLimits.minDurationMinutes ||
      duration > templateLimits.durationMinutes)
  )
    return templateError('duration_minutes', key);
  if (duration !== undefined && start === undefined)
    return templateError('duration_requires_start_time', key);
  if (offset !== undefined && !placeableKinds.includes(base.kind))
    return templateError('scheduling_not_supported', key);
  if (start !== undefined && !timedKinds.includes(base.kind))
    return templateError('time_not_supported', key);
  return ok({
    ...base,
    ...(offset === undefined ? {} : { relativeDayOffset: offset }),
    ...(wallTime === undefined ? {} : { localStartTime: wallTime }),
    ...(duration === undefined ? {} : { durationMinutes: duration }),
  });
};

/**
 * Runtime validation for persisted, imported, or edited blueprints. Version 1 is decoded without
 * reinterpretation; unknown versions and unknown fields are rejected.
 */
export const parseTemplateBlueprint = (value: unknown): DomainResult<TemplateBlueprint> => {
  if (!isRecord(value) || Object.keys(value).some((name) => name !== 'version' && name !== 'items'))
    return templateError('shape');
  const version = value['version'];
  if (version !== 1 && version !== 2) return templateError('unsupported_version');
  const rawItems = value['items'];
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > templateLimits.items)
    return templateError('item_count');
  const items: (TemplateBlueprintItemV1 | TemplateBlueprintItemV2)[] = [];
  for (const raw of rawItems) {
    const item = parseItem(raw, version);
    if (!item.ok) return item;
    items.push(item.value);
  }
  const byKey = new Map(items.map((item) => [item.templateKey, item]));
  if (byKey.size !== items.length) return templateError('duplicate_template_key');
  for (const item of items) {
    if (item.parentTemplateKey === undefined) {
      if (item.kind === 'milestone')
        return templateError('milestone_requires_outcome', item.templateKey);
      continue;
    }
    const parent = byKey.get(item.parentTemplateKey);
    if (parent === undefined || parent.templateKey === item.templateKey)
      return templateError('dangling_parent', item.templateKey);
    if (!templateParentKinds[item.kind].includes(parent.kind))
      return templateError('parent_kind', item.templateKey);
  }
  return version === 1 ? ok({ version: 1, items }) : ok({ version: 2, items: items });
};

export type TemplatePlacementHorizon = 'day' | 'week' | 'month';

export type TemplateItemSchedule =
  | { readonly kind: 'unscheduled' }
  | {
      readonly kind: 'date';
      readonly date: CalendarDate;
      readonly placement: TemplatePlacementHorizon;
    }
  | {
      readonly kind: 'timed';
      readonly date: CalendarDate;
      readonly startsAt: Instant;
      readonly endsAt: Instant;
      readonly localStart: WallTime;
      readonly localEnd: WallTime;
      readonly endDate: CalendarDate;
      readonly utcOffset: string;
      readonly durationMinutes: number;
      readonly adjustment?: 'dst_gap_shifted' | 'dst_repeated_earlier';
    };

export interface TemplatePreviewItem {
  readonly templateKey: string;
  readonly kind: TemplateItemKind;
  readonly title: string;
  readonly parentTemplateKey?: string;
  readonly note?: string;
  readonly estimateMinutes?: number;
  readonly energy?: EnergyLabel;
  readonly priority?: Priority;
  readonly selected: boolean;
  readonly schedule: TemplateItemSchedule;
}

export type TemplatePreviewIssueCode =
  | 'nothing_selected'
  | 'parent_deselected'
  | 'unsupported_kind'
  | 'success_definition_required'
  | 'checkpoint_required'
  | 'commitment_time_required'
  | 'duration_required';

export interface TemplatePreviewIssue {
  readonly code: TemplatePreviewIssueCode;
  readonly templateKey?: string;
  readonly parentTemplateKey?: string;
}

export interface TemplatePreview {
  readonly anchorDate: CalendarDate;
  readonly timeZone: IanaTimeZone;
  readonly items: readonly TemplatePreviewItem[];
  readonly issues: readonly TemplatePreviewIssue[];
  readonly selectedCount: number;
}

export interface TemplatePreviewRequest {
  readonly anchorDate: string;
  readonly timeZone: string;
  /** Undefined selects every item. */
  readonly selectedKeys?: ReadonlySet<string>;
}

const placementFor = (kind: TemplateItemKind): TemplatePlacementHorizon =>
  kind === 'action' ? 'day' : kind === 'outcome' ? 'month' : 'week';

const resolveTimed = (
  date: CalendarDate,
  wallTime: WallTime,
  durationMinutes: number,
  timeZone: IanaTimeZone,
): TemplateItemSchedule => {
  const resolved = resolveLocalInterval(date, wallTime, durationMinutes, timeZone);
  return {
    kind: 'timed',
    date,
    startsAt: resolved.startsAt,
    endsAt: resolved.endsAt,
    localStart: resolved.localStart,
    localEnd: resolved.localEnd,
    endDate: resolved.localEndDate,
    utcOffset: resolved.utcOffset,
    durationMinutes,
    ...(resolved.adjustment === undefined ? {} : { adjustment: resolved.adjustment }),
  };
};

/**
 * Resolve every item's exact dates/times for an anchor date and explicit IANA zone, then validate
 * the selected subset. Issues block application; nothing is created by a preview.
 */
export const previewTemplateApplication = (
  blueprint: TemplateBlueprint,
  request: TemplatePreviewRequest,
): DomainResult<TemplatePreview> => {
  const anchor = parseCalendarDate(request.anchorDate);
  if (!anchor.ok) return anchor;
  const zone = parseIanaTimeZone(request.timeZone);
  if (!zone.ok) return zone;
  const selectedKeys = request.selectedKeys;
  const isSelected = (key: string): boolean => selectedKeys === undefined || selectedKeys.has(key);
  const issues: TemplatePreviewIssue[] = [];
  const items: TemplatePreviewItem[] = blueprint.items.map((item) => {
    const scheduling: Pick<
      TemplateBlueprintItemV2,
      'relativeDayOffset' | 'localStartTime' | 'durationMinutes'
    > = blueprint.version === 2 ? (item as TemplateBlueprintItemV2) : {};
    const selected = isSelected(item.templateKey);
    let schedule: TemplateItemSchedule = { kind: 'unscheduled' };
    if (scheduling.relativeDayOffset !== undefined) {
      const date = addDays(anchor.value, scheduling.relativeDayOffset);
      schedule =
        scheduling.localStartTime !== undefined && scheduling.durationMinutes !== undefined
          ? resolveTimed(date, scheduling.localStartTime, scheduling.durationMinutes, zone.value)
          : { kind: 'date', date, placement: placementFor(item.kind) };
      if (
        selected &&
        scheduling.localStartTime !== undefined &&
        scheduling.durationMinutes === undefined
      ) {
        issues.push({ code: 'duration_required', templateKey: item.templateKey });
      }
    }
    if (selected) {
      if (item.kind === 'routine')
        issues.push({ code: 'unsupported_kind', templateKey: item.templateKey });
      if (item.kind === 'outcome' && item.note === undefined)
        issues.push({ code: 'success_definition_required', templateKey: item.templateKey });
      if (item.kind === 'milestone' && item.note === undefined)
        issues.push({ code: 'checkpoint_required', templateKey: item.templateKey });
      if (item.kind === 'commitment' && schedule.kind !== 'timed')
        issues.push({ code: 'commitment_time_required', templateKey: item.templateKey });
      if (item.parentTemplateKey !== undefined && !isSelected(item.parentTemplateKey)) {
        issues.push({
          code: 'parent_deselected',
          templateKey: item.templateKey,
          parentTemplateKey: item.parentTemplateKey,
        });
      }
    }
    return {
      templateKey: item.templateKey,
      kind: item.kind,
      title: item.title,
      ...(item.parentTemplateKey === undefined
        ? {}
        : { parentTemplateKey: item.parentTemplateKey }),
      ...(item.note === undefined ? {} : { note: item.note }),
      ...(item.estimateMinutes === undefined ? {} : { estimateMinutes: item.estimateMinutes }),
      ...(item.energy === undefined ? {} : { energy: item.energy }),
      ...(item.priority === undefined ? {} : { priority: item.priority }),
      selected,
      schedule,
    };
  });
  const selectedCount = items.filter((item) => item.selected).length;
  if (selectedCount === 0) issues.unshift({ code: 'nothing_selected' });
  return ok({ anchorDate: anchor.value, timeZone: zone.value, items, issues, selectedCount });
};
