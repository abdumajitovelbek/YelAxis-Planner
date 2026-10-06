import {
  alignmentLinkId,
  allowedPlacementKinds,
  createWeekPeriod,
  dayFocusLimit,
  occurrenceLogicalKey,
  routineOccurrenceId,
  validPeriod,
  type CalendarDate,
  type EntityType,
  type GeneratedOccurrencePeriod,
  type HorizonPeriod,
  type UUID,
  type Weekday,
} from '@yelaxis/domain';

import type { BundleSupplement, CanonicalSnapshotRecord } from './account-contracts';
import type {
  ImportBundle,
  ImportChoice,
  ImportConflict,
  ImportDestination,
  ImportMode,
  ImportPreview,
  ImportProblem,
} from './import-contracts';
import { sameDocument } from './sync-merge';

const fieldTypes: Readonly<Record<string, EntityType>> = Object.freeze({
  axisId: 'axis',
  outcomeId: 'outcome',
  primaryOutcomeId: 'outcome',
  milestoneId: 'milestone',
  projectId: 'project',
  actionId: 'action',
  commitmentId: 'commitment',
  routineId: 'routine',
  routineOccurrenceId: 'routine_occurrence',
  reviewId: 'review',
  timeBlockId: 'time_block',
  supersededById: 'time_block',
  contextId: 'context',
  profileId: 'profile',
});
const key = (type: EntityType, id: string) => `${type}:${id}`;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Typed canonical references at every document depth; arbitrary user text is never an ID. */
export function importDocumentLinks(
  document: Readonly<Record<string, unknown>>,
  options: { readonly includeHistoricalConversions?: boolean } = {},
): readonly { readonly type: EntityType; readonly id: UUID }[] {
  const result: { type: EntityType; id: UUID }[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!object(value)) return;
    for (const [field, child] of Object.entries(value)) {
      const type = fieldTypes[field];
      if (type !== undefined && typeof child === 'string') result.push({ type, id: child as UUID });
      else if (
        field === 'convertedTo' &&
        object(child) &&
        (child['type'] === 'note' || child['type'] === 'project') &&
        typeof child['id'] === 'string'
      ) {
        if (options.includeHistoricalConversions !== false)
          result.push({ type: child['type'], id: child['id'] as UUID });
      } else visit(child);
    }
  };
  visit(document);
  return result;
}

export function remapImportDocument(
  document: Readonly<Record<string, unknown>>,
  remap: Readonly<Record<string, UUID>>,
): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!object(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([field, child]) => {
        const type = fieldTypes[field];
        if (type !== undefined && typeof child === 'string')
          return [field, remap[key(type, child)] ?? child];
        if (
          field === 'convertedTo' &&
          object(child) &&
          (child['type'] === 'note' || child['type'] === 'project') &&
          typeof child['id'] === 'string'
        )
          return [field, { ...child, id: remap[key(child['type'], child['id'])] ?? child['id'] }];
        return [field, visit(child)];
      }),
    );
  };
  return visit(document) as Record<string, unknown>;
}

function derivedId(
  record: CanonicalSnapshotRecord,
  remap: Readonly<Record<string, UUID>>,
): UUID | null {
  const doc = remapImportDocument(record.document, remap);
  if (record.type === 'routine_occurrence')
    return routineOccurrenceId(
      occurrenceLogicalKey(
        doc['routineId'] as UUID,
        doc['generation'] as number,
        doc['period'] as GeneratedOccurrencePeriod,
      ),
    );
  if (record.type === 'project_secondary_outcome')
    return alignmentLinkId(
      'outcome_secondary_project',
      doc['outcomeId'] as UUID,
      doc['projectId'] as UUID,
    );
  if (record.type === 'milestone_project')
    return alignmentLinkId(
      'milestone_project',
      doc['milestoneId'] as UUID,
      doc['projectId'] as UUID,
    );
  if (record.type === 'milestone_action')
    return alignmentLinkId('milestone_action', doc['milestoneId'] as UUID, doc['actionId'] as UUID);
  return null;
}

export interface ImportPlan {
  readonly preview: Omit<ImportPreview, 'previewId'>;
  /** Resulting canonical graph, checked before any write. */
  readonly records: readonly CanonicalSnapshotRecord[];
  readonly accepted: readonly CanonicalSnapshotRecord[];
  readonly deleted: readonly CanonicalSnapshotRecord[];
  readonly restored: readonly { readonly type: EntityType; readonly id: UUID }[];
  readonly supplement: BundleSupplement;
  readonly remap: Readonly<Record<string, UUID>>;
}

export function buildImportPlan(
  bundle: ImportBundle,
  destination: ImportDestination,
  choices: readonly ImportChoice[],
  mode: ImportMode,
  savedRemap: Readonly<Record<string, UUID>>,
  nextId: () => UUID,
): ImportPlan {
  const current = new Map(destination.snapshot.records.map((row) => [key(row.type, row.id), row]));
  const incoming = new Map(bundle.records.map((row) => [key(row.type, row.id), row]));
  const decisions = new Map(
    choices.map((choice) => [key(choice.type, choice.id), choice.decision]),
  );
  const currentDeleted = new Set(
    (destination.supplement.tombstones ?? []).map((row) => key(row.entityType, row.entityId)),
  );
  const remap: Record<string, UUID> = { ...savedRemap };
  const sourceProfile = bundle.records.find((row) => row.type === 'profile');
  const destinationProfile = destination.snapshot.records.find((row) => row.type === 'profile');
  if (sourceProfile !== undefined && destinationProfile !== undefined)
    remap[key('profile', sourceProfile.id)] = destinationProfile.id;

  // Duplicate the selected incoming component, including dependents and shared incoming parents.
  // The destination's one Profile is always retained and used by remapped Focus/Review records.
  const adjacency = new Map<string, Set<string>>();
  for (const [source, record] of incoming) {
    for (const link of importDocumentLinks(record.document)) {
      const target = key(link.type, link.id);
      if (link.type === 'profile' || !incoming.has(target)) continue;
      const left = adjacency.get(source) ?? new Set<string>();
      left.add(target);
      adjacency.set(source, left);
      const right = adjacency.get(target) ?? new Set<string>();
      right.add(source);
      adjacency.set(target, right);
    }
  }
  const duplicate = new Set<string>();
  const queue = choices
    .filter(
      (choice) =>
        choice.decision === 'duplicate_imported' &&
        choice.type !== 'profile' &&
        incoming.has(key(choice.type, choice.id)),
    )
    .map((choice) => key(choice.type, choice.id));
  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    if (candidate === undefined || duplicate.has(candidate)) continue;
    duplicate.add(candidate);
    for (const neighbor of adjacency.get(candidate) ?? [])
      if (!duplicate.has(neighbor)) queue.push(neighbor);
  }
  for (const candidate of duplicate) remap[candidate] ??= nextId();
  // The identities of joins and occurrences are derived from their remapped endpoints.
  for (const row of bundle.records) {
    if (duplicate.has(key(row.type, row.id))) {
      const derived = derivedId(row, remap);
      if (derived !== null) remap[key(row.type, row.id)] = derived;
    }
  }

  const conflicts: ImportConflict[] = [];
  const linkTitles = Object.fromEntries(
    [...destination.snapshot.records, ...bundle.records].map((record) => [
      record.id,
      typeof record.document['title'] === 'string'
        ? record.document['title']
        : record.type.replaceAll('_', ' '),
    ]),
  );
  const accepted: CanonicalSnapshotRecord[] = [];
  const restored: { type: EntityType; id: UUID }[] = [];
  const result = mode === 'replace' ? new Map<string, CanonicalSnapshotRecord>() : new Map(current);
  let identicalSkips = 0;
  let keeps = 0;
  let useSettings = mode === 'replace';
  for (const original of bundle.records) {
    const sourceKey = key(original.type, original.id);
    const row = {
      ...original,
      id: remap[sourceKey] ?? original.id,
      document: remapImportDocument(original.document, remap),
    };
    const rowKey = key(row.type, row.id);
    const existing = current.get(rowKey);
    const settingDifference =
      row.type === 'profile' &&
      bundle.supplement.profileSettings !== null &&
      !sameDocument(
        {
          preferredName: bundle.supplement.profileSettings.preferredName,
          localeOverride: bundle.supplement.profileSettings.localeOverride,
          deviceState: bundle.supplement.profileSettings.deviceState,
          onboardingDraft: bundle.supplement.profileSettings.onboardingDraft,
          onboardingArtifacts: bundle.supplement.profileSettings.onboardingArtifacts,
        },
        {
          preferredName: destination.supplement.profileSettings?.preferredName ?? null,
          localeOverride: destination.supplement.profileSettings?.localeOverride ?? null,
          deviceState: destination.supplement.profileSettings?.deviceState,
          onboardingDraft: destination.supplement.profileSettings?.onboardingDraft,
          onboardingArtifacts: destination.supplement.profileSettings?.onboardingArtifacts,
        },
      );
    if (
      !duplicate.has(sourceKey) &&
      existing !== undefined &&
      sameDocument(existing.document, row.document) &&
      !settingDifference
    ) {
      identicalSkips += 1;
      result.set(rowKey, existing);
      if (row.type === 'profile') useSettings = true;
      continue;
    }
    const collision = existing !== undefined || currentDeleted.has(rowKey);
    const choice = decisions.get(sourceKey) ?? (mode === 'replace' ? 'use_imported' : undefined);
    if (collision && !duplicate.has(sourceKey)) {
      if (choice === undefined) {
        conflicts.push({
          type: original.type,
          id: original.id,
          title:
            typeof row.document['title'] === 'string'
              ? row.document['title']
              : original.type.replaceAll('_', ' '),
          reason: existing === undefined ? 'deleted_here' : 'id_collision',
          choices:
            row.type === 'profile'
              ? ['keep_current', 'use_imported']
              : ['keep_current', 'use_imported', 'duplicate_imported'],
          current: {
            deleted: existing === undefined,
            document:
              existing === undefined
                ? null
                : row.type === 'profile'
                  ? profileComparison(existing.document, destination.supplement.profileSettings)
                  : existing.document,
          },
          imported: {
            deleted: false,
            document:
              row.type === 'profile'
                ? profileComparison(row.document, bundle.supplement.profileSettings)
                : row.document,
          },
          linkTitles,
        });
        if (existing !== undefined) result.set(rowKey, existing);
        continue;
      }
      if (choice === 'keep_current') {
        keeps += 1;
        if (existing !== undefined) result.set(rowKey, existing);
        continue;
      }
    }
    if (currentDeleted.has(rowKey)) restored.push({ type: row.type, id: row.id });
    result.set(rowKey, row);
    accepted.push(row);
    if (row.type === 'profile') useSettings = true;
  }
  // A Profile survives replacement because it belongs to the destination identity.
  if (destinationProfile !== undefined && !result.has(key('profile', destinationProfile.id)))
    result.set(key('profile', destinationProfile.id), destinationProfile);

  const importedTombstones = [];
  for (const tombstone of bundle.supplement.tombstones ?? []) {
    const rowKey = key(tombstone.entityType, tombstone.entityId);
    const live = current.get(rowKey);
    if (live !== undefined) {
      const choice = decisions.get(rowKey);
      if (choice === undefined) {
        conflicts.push({
          type: tombstone.entityType,
          id: tombstone.entityId,
          title:
            typeof live.document['title'] === 'string'
              ? live.document['title']
              : tombstone.entityType,
          reason: 'imported_tombstone',
          choices: ['keep_current', 'use_imported'],
          current: { deleted: false, document: live.document },
          imported: { deleted: true, document: null },
          linkTitles,
        });
        result.set(rowKey, live);
        continue;
      }
      if (choice === 'keep_current') {
        result.set(rowKey, live);
        keeps += 1;
        continue;
      }
      result.delete(rowKey);
    }
    if (!result.has(rowKey)) importedTombstones.push(tombstone);
  }
  const deleted = destination.snapshot.records.filter(
    (row) => row.type !== 'profile' && !result.has(key(row.type, row.id)),
  );
  const problems = validateImportGraph([...result.values()]);
  if (destination.unconfirmedSync) problems.push({ code: 'unconfirmed_sync' });
  if (
    destination.supplement.openConflicts.length > 0 &&
    (mode === 'replace' ||
      accepted.some((row) =>
        destination.supplement.openConflicts.some(
          (conflict) => conflict.entityType === row.type && conflict.entityId === row.id,
        ),
      ))
  )
    problems.push({ code: 'destination_conflicts' });
  const settings = useSettings ? bundle.supplement.profileSettings : null;
  for (const candidate of bundle.supplement.openConflicts) {
    const existing = destination.supplement.openConflicts.find(
      (row) => row.conflictId === candidate.conflictId,
    );
    if (
      existing !== undefined &&
      !sameDocument(
        existing as unknown as Record<string, unknown>,
        candidate as unknown as Record<string, unknown>,
      )
    )
      remap[`recovery_conflict:${candidate.conflictId}`] ??= nextId();
  }
  const supplement: BundleSupplement = {
    ...bundle.supplement,
    profileSettings: settings,
    tombstones: importedTombstones,
  };
  return {
    records: [...result.values()],
    accepted,
    deleted,
    restored,
    supplement,
    remap,
    preview: {
      bundleId: bundle.bundleId,
      mode,
      creates: accepted.filter((row) => !current.has(key(row.type, row.id))).length,
      updates: accepted.filter((row) => current.has(key(row.type, row.id))).length,
      deletes: deleted.length,
      identicalSkips,
      keeps,
      conflicts,
      problems,
      decisions: choices,
      sensitiveContextCount: bundle.records.filter(
        (row) => row.type === 'context' && row.document['sensitivity'] === 'sensitive',
      ).length,
      recoveryConflicts: bundle.supplement.openConflicts.length,
      expectedStorageBytes: bundle.bytes * 2,
      accountLinked: destination.accountLinked,
      backupRequired: destination.snapshot.records.length > 0,
      canApply: conflicts.length === 0 && problems.length === 0,
    },
  };
}

/** Domain graph checks that record-shape codecs cannot establish on their own. */
export function validateImportGraph(records: readonly CanonicalSnapshotRecord[]): ImportProblem[] {
  const byKey = new Map(records.map((row) => [key(row.type, row.id), row]));
  const problems: ImportProblem[] = [];
  const profiles = records.filter((row) => row.type === 'profile');
  if (profiles.length !== 1) problems.push({ code: 'required_profile' });
  const focusByDay = new Map<string, Set<string>>();
  const uniqueTargets = new Set<string>();
  const uniqueSlots = new Set<string>();
  const issue = (row: CanonicalSnapshotRecord, code: ImportProblem['code']) => {
    if (
      !problems.some(
        (problem) => problem.type === row.type && problem.id === row.id && problem.code === code,
      )
    )
      problems.push({ code, type: row.type, id: row.id });
  };
  const weekValid = (period: Record<string, unknown>) => {
    if (period['kind'] !== 'week') return true;
    try {
      const expected = createWeekPeriod(
        period['start'] as CalendarDate,
        period['weekStart'] as Weekday,
      );
      return expected.start === period['start'] && expected.end === period['end'];
    } catch {
      return false;
    }
  };
  for (const row of records) {
    // Conversion pointers are historical: normal permanent deletion may already have removed
    // the converted Note or Project. Their surviving IDs still participate in duplicate remapping.
    for (const link of importDocumentLinks(row.document, { includeHistoricalConversions: false }))
      if (!byKey.has(key(link.type, link.id))) issue(row, 'missing_reference');
    const doc = row.document;
    const unique = (slot: string): void => {
      if (uniqueSlots.has(slot)) issue(row, 'duplicate_target');
      uniqueSlots.add(slot);
    };
    if (object(doc['period']) && !weekValid(doc['period'])) issue(row, 'invalid_period');
    if (row.type === 'planning_placement') {
      const period = doc['period'] as HorizonPeriod;
      const target = doc['target'] as { kind: keyof typeof allowedPlacementKinds };
      if (!validPeriod(period) || !allowedPlacementKinds[target.kind].includes(period.kind))
        issue(row, 'invalid_period');
      if (doc['archivedAt'] === undefined) unique(`placement:${canonicalKey(target)}`);
    }
    if (row.type === 'time_block' && doc['state'] === 'planned' && object(doc['target'])) {
      const target = doc['target'];
      if (target['kind'] === 'action' || target['kind'] === 'commitment')
        unique(`block:${canonicalKey(target)}`);
      if (target['kind'] === 'routine_occurrence') {
        const occurrence = byKey.get(
          key('routine_occurrence', String(target['routineOccurrenceId'])),
        );
        if (
          object(occurrence?.document['period']) &&
          occurrence.document['period']['kind'] === 'date'
        )
          unique(`block:${canonicalKey(target)}`);
      }
    }
    if ((row.type === 'theme' || row.type === 'direction') && doc['archivedAt'] === undefined)
      unique(
        `${row.type}:${String(doc['profileId'])}:${String(doc[row.type === 'theme' ? 'month' : 'year'])}`,
      );
    if (row.type === 'review' && doc['archivedAt'] === undefined)
      unique(
        `review:${String(doc['profileId'])}:${String(doc['reviewType'])}:${String(doc['periodStart'])}:${String(doc['periodEnd'])}`,
      );
    if (row.type === 'focus_selection' && doc['archivedAt'] === undefined) {
      const target = object(doc['target']) ? canonicalKey(doc['target']) : '';
      const period = `${String(doc['profileId'])}:${String(doc['kind'])}:${String(doc['periodStart'])}:${String(doc['periodEnd'])}`;
      if (uniqueTargets.has(`${period}:${target}`)) issue(row, 'duplicate_target');
      uniqueTargets.add(`${period}:${target}`);
      if (doc['kind'] === 'day_focus') {
        const set = focusByDay.get(period) ?? new Set<string>();
        set.add(row.id);
        focusByDay.set(period, set);
        if (set.size > dayFocusLimit) issue(row, 'focus_limit');
      } else if (
        !weekValid({
          kind: 'week',
          start: doc['periodStart'],
          end: doc['periodEnd'],
          weekStart: doc['weekStart'],
        })
      )
        issue(row, 'invalid_period');
    }
    if (row.type === 'routine') {
      const generations = doc['generations'];
      if (
        !Array.isArray(generations) ||
        !generations.every(
          (generation: unknown, index) =>
            object(generation) && generation['generation'] === index + 1,
        )
      )
        issue(row, 'routine_mismatch');
    }
    if (row.type === 'routine_occurrence' || row.type === 'routine_action_defaults') {
      const routine = byKey.get(key('routine', String(doc['routineId'])));
      const generations = routine?.document['generations'];
      if (
        !Array.isArray(generations) ||
        !generations.some(
          (generation: unknown) =>
            object(generation) && generation['generation'] === doc['generation'],
        ) ||
        (row.type === 'routine_occurrence' && derivedId(row, {}) !== row.id)
      )
        issue(row, 'routine_mismatch');
      if (row.type === 'routine_action_defaults')
        unique(`routine_defaults:${String(doc['routineId'])}:${String(doc['generation'])}`);
    }
    if (
      row.type === 'milestone_action' ||
      row.type === 'milestone_project' ||
      row.type === 'project_secondary_outcome'
    ) {
      if (derivedId(row, {}) !== row.id) issue(row, 'relationship_mismatch');
    }
    if (row.type === 'project_secondary_outcome' && doc['unlinkedAt'] === undefined) {
      const project = byKey.get(key('project', String(doc['projectId'])));
      if (project?.document['primaryOutcomeId'] === doc['outcomeId'])
        issue(row, 'relationship_mismatch');
    }
  }
  return problems;
}

function canonicalKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(',')}]`;
  if (object(value))
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, child]) => `${field}:${canonicalKey(child)}`)
      .join(',')}}`;
  return String(value);
}

function profileComparison(
  document: Readonly<Record<string, unknown>>,
  settings: BundleSupplement['profileSettings'],
): Record<string, unknown> {
  return {
    ...document,
    preferredName: settings?.preferredName ?? null,
    localeOverride: settings?.localeOverride ?? null,
    ...(settings?.deviceState === undefined ? {} : { deviceState: settings.deviceState }),
    ...(settings?.onboardingDraft === undefined
      ? {}
      : { onboardingDraft: settings.onboardingDraft }),
    ...(settings?.onboardingArtifacts === undefined
      ? {}
      : { onboardingArtifacts: settings.onboardingArtifacts }),
  };
}
