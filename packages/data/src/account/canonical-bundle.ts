import type {
  BundleVerification,
  CanonicalBundleManifest,
  CanonicalBundlePort,
  EncodeBundleInput,
  EncodedBundle,
  ImportBundle,
  ImportBundleDecoder,
  ImportResult,
} from '@yelaxis/application';
import {
  onboardingSteps,
  parseIanaTimeZone,
  parseInstant,
  type EntityType,
  type Instant,
  type UUID,
} from '@yelaxis/domain';
import { z } from 'zod';

import { actionCanonicalDocumentSchema } from '../application/action-codec';
import { instant, uuid } from '../application/base-codec';
import {
  axisDocumentSchema,
  constraintDocumentSchema,
  milestoneDocumentSchema,
  outcomeDocumentSchema,
} from '../application/horizon-codecs';
import {
  commitmentDocumentSchema,
  focusSelectionDocumentSchema,
  monthThemeDocumentSchema,
  noteDocumentSchema,
  planningPlacementDocumentSchema,
  projectDocumentSchema,
  reminderDocumentSchema,
  templateDocumentSchema,
  timeBlockDocumentSchema,
  yearDirectionDocumentSchema,
} from '../application/planning-codecs';
import { profilePlanningDocumentSchema } from '../application/profile-codec';
import {
  milestoneActionDocumentSchema,
  milestoneProjectDocumentSchema,
  projectSecondaryOutcomeDocumentSchema,
} from '../application/relationship-codecs';
import { reviewDocumentSchema, reviewItemDocumentSchema } from '../application/review-codecs';
import {
  routineActionDefaultsDocumentSchema,
  routineDocumentSchema,
  routineOccurrenceDocumentSchema,
} from '../application/routine-codecs';
import { contextDocumentSchema } from './context-document';

/*
 * Canonical JSON bundle v1, export side (export contract). The bundle carries every
 * canonical record as its codec document with its stable id and local revision, sorted by type and
 * id; the Profile settings that stay on a device (preferred name and locale); and the candidates of
 * open conflicts, minimized for recovery. It never carries owners, sessions or tokens, outbox
 * entries, cursors, replica or device ids, server revisions, or server conflict ids. Imports use
 * the validated recovery application.
 */

export const canonicalBundleFormat = 'yelaxis.backup';
export const canonicalBundleFormatVersion = 1;

/** The `data` section of each entity type. */
export const bundleSections: Readonly<Record<EntityType, string>> = Object.freeze({
  action: 'actions',
  axis: 'axes',
  commitment: 'commitments',
  constraint: 'constraints',
  context: 'contexts',
  direction: 'directions',
  focus_selection: 'focus_selections',
  milestone: 'milestones',
  milestone_action: 'milestone_actions',
  milestone_project: 'milestone_projects',
  note: 'notes',
  outcome: 'outcomes',
  planning_placement: 'planning_placements',
  profile: 'profile',
  project: 'projects',
  project_secondary_outcome: 'project_secondary_outcomes',
  reminder: 'reminders',
  review: 'reviews',
  review_item: 'review_items',
  routine: 'routines',
  routine_action_defaults: 'routine_action_defaults',
  routine_occurrence: 'routine_occurrences',
  template: 'templates',
  theme: 'themes',
  time_block: 'time_blocks',
});

const documentSchemas: Readonly<Record<EntityType, z.ZodType>> = {
  action: actionCanonicalDocumentSchema,
  axis: axisDocumentSchema,
  commitment: commitmentDocumentSchema,
  constraint: constraintDocumentSchema,
  context: contextDocumentSchema,
  direction: yearDirectionDocumentSchema,
  focus_selection: focusSelectionDocumentSchema,
  milestone: milestoneDocumentSchema,
  milestone_action: milestoneActionDocumentSchema,
  milestone_project: milestoneProjectDocumentSchema,
  note: noteDocumentSchema,
  outcome: outcomeDocumentSchema,
  planning_placement: planningPlacementDocumentSchema,
  profile: profilePlanningDocumentSchema,
  project: projectDocumentSchema,
  project_secondary_outcome: projectSecondaryOutcomeDocumentSchema,
  reminder: reminderDocumentSchema,
  review: reviewDocumentSchema,
  review_item: reviewItemDocumentSchema,
  routine: routineDocumentSchema,
  routine_action_defaults: routineActionDefaultsDocumentSchema,
  routine_occurrence: routineOccurrenceDocumentSchema,
  template: templateDocumentSchema,
  theme: monthThemeDocumentSchema,
  time_block: timeBlockDocumentSchema,
};

/**
 * The bundle's sections beyond the canonical records: the Profile's device settings (one record
 * with the Profile's id and revision) and the open conflicts' candidates (one per conflict).
 */
export const bundleSupplementSections = Object.freeze({
  profileSettings: 'profile_settings',
  conflictCandidates: 'conflict_candidates',
  tombstones: 'tombstones',
  history: 'history',
} as const);

const typeBySection = new Map(
  (Object.entries(bundleSections) as [EntityType, string][]).map(([type, section]) => [
    section,
    type,
  ]),
);
const entityTypes = [...typeBySection.values()] as [EntityType, ...EntityType[]];
const recordSectionNames = Object.freeze([...typeBySection.keys()].sort(compareText));
const sectionNames = Object.freeze(
  [...recordSectionNames, ...Object.values(bundleSupplementSections)].sort(compareText),
);
const legacySectionNames = Object.freeze(
  sectionNames.filter((name) => name !== 'history' && name !== 'tombstones'),
);

/** Input bounds apply before parsing and to the parsed JSON tree, including supplement content. */
export const importLimits = Object.freeze({
  bytes: 50 * 1024 * 1024,
  depth: 40,
  records: 100_000,
  stringLength: 100_000,
  nodes: 1_000_000,
});

const bundleDocument = z.record(z.string(), z.unknown());
const bundleRecordSchema = z.strictObject({
  id: uuid,
  revision: z.number().int().positive(),
  document: bundleDocument,
});

const stepDraftSchema = z.strictObject({
  identity: z.strictObject({ preferredName: z.string().max(80), locale: z.string().max(64) }),
  defaults: z
    .strictObject({
      planningTimeZone: z.string().max(100),
      weekStart: z.enum([
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
        'sunday',
      ]),
      timeFormat: z.enum(['12_hour', '24_hour']),
      locale: z.string().max(64),
    })
    .nullable(),
  context: z.strictObject({
    awakeWindow: z.strictObject({ start: z.string().max(8), end: z.string().max(8) }).optional(),
    availability: z
      .strictObject({
        label: z.string().max(200),
        weekdays: z
          .array(
            z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
          )
          .max(7),
        start: z.string().max(8),
        end: z.string().max(8),
        strength: z.enum(['hard', 'soft', 'unknown']),
      })
      .optional(),
    boundary: z
      .strictObject({ text: z.string().max(2000), strength: z.enum(['hard', 'soft', 'unknown']) })
      .optional(),
  }),
  axes: z.array(z.string().max(200)).max(3),
  outcome: z
    .strictObject({
      title: z.string().max(200),
      successDefinition: z.string().max(2000),
      axisIndex: z.number().int().min(0).max(2).optional(),
      targetDate: z.string().max(10).optional(),
    })
    .nullable(),
  week: z.strictObject({
    commitments: z
      .array(
        z.strictObject({
          title: z.string().max(200),
          date: z.string().max(10),
          start: z.string().max(8),
          end: z.string().max(8),
          strength: z.enum(['hard', 'soft']),
          confirmed: z.boolean(),
          timeZone: z.string().max(100).optional(),
        }),
      )
      .max(3),
    actionTitle: z.string().max(200),
  }),
});
const artifactsSchema = z.strictObject({
  axisIds: z.array(uuid).max(3),
  outcomeId: uuid.optional(),
  actionId: uuid.optional(),
  placementId: uuid.optional(),
  focusId: uuid.optional(),
  weekSelectionId: uuid.optional(),
  awakeContextId: uuid.optional(),
  availabilityContextId: uuid.optional(),
  availabilityConstraintId: uuid.optional(),
  boundaryContextId: uuid.optional(),
  commitments: z.array(z.strictObject({ commitmentId: uuid, timeBlockId: uuid })).max(3),
});

/** The Profile settings onboarding keeps on a device, within the limits setup enforces. */
const profileSettingsDocumentSchema = z.strictObject({
  preferredName: z.string().max(80).nullable(),
  localeOverride: z.string().max(64).nullable(),
  deviceState: z
    .strictObject({
      defaultsConfirmedAt: instant.nullable(),
      onboarding: z.strictObject({
        status: z.enum(['not_started', 'in_progress', 'completed']),
        step: z.enum(onboardingSteps),
        completedSteps: z.array(z.enum(onboardingSteps)).max(onboardingSteps.length),
        skippedSteps: z.array(z.enum(onboardingSteps)).max(onboardingSteps.length),
        completedAt: instant.nullable(),
      }),
      handbook: z.strictObject({
        status: z.enum(['not_started', 'in_progress', 'skipped', 'completed']),
        lesson: z.number().int().min(0).max(4),
        completedLessons: z.array(z.number().int().min(0).max(3)).max(4),
      }),
    })
    .optional(),
  onboardingDraft: stepDraftSchema.nullable().optional(),
  onboardingArtifacts: artifactsSchema.optional(),
});
const conflictSideSchema = z.strictObject({
  deleted: z.boolean(),
  document: bundleDocument.nullable(),
});
const conflictCandidateDocumentSchema = z.strictObject({
  entityType: z.enum(entityTypes),
  entityId: uuid,
  kind: z.enum([
    'stale_base',
    'edit_versus_delete',
    'delete_versus_edit',
    'create_collision',
    'merge_conflict',
  ]),
  fields: z.array(z.string().min(1).max(100)).max(200),
  base: bundleDocument.nullable(),
  local: conflictSideSchema,
  remote: conflictSideSchema,
  createdAt: instant,
});
const supplementSchemas: Readonly<Record<string, z.ZodType>> = {
  [bundleSupplementSections.profileSettings]: profileSettingsDocumentSchema,
  [bundleSupplementSections.conflictCandidates]: conflictCandidateDocumentSchema,
  [bundleSupplementSections.tombstones]: z.strictObject({
    entityType: z.enum(entityTypes),
    entityId: uuid,
    deletedAt: instant,
  }),
  [bundleSupplementSections.history]: z.strictObject({
    entityType: z.enum(entityTypes),
    entityId: uuid,
    eventType: z.string().min(1).max(100),
    actor: z.enum(['user', 'import', 'sync', 'intelligence_proposal']),
    occurredAt: instant,
  }),
};
const manifestSchema = z.strictObject({
  sections: z.array(z.string()),
  recordCounts: z.record(z.string(), z.number().int().nonnegative()),
  sourceMode: z.enum(['local', 'account']),
  containsSensitiveContext: z.boolean(),
  syncWasPending: z.boolean(),
  dataSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
const bundleSchema = z.strictObject({
  format: z.literal(canonicalBundleFormat),
  formatVersion: z.literal(canonicalBundleFormatVersion),
  bundleId: uuid,
  exportedAt: instant,
  appVersion: z.string().min(1).max(100),
  manifest: manifestSchema,
  data: z.record(z.string(), z.array(bundleRecordSchema)),
});

type BundleRecord = z.infer<typeof bundleRecordSchema>;

/**
 * Deterministic JSON: object keys sorted at every level, no whitespace, `undefined` members left
 * out. The digest is computed over this serialization of `data`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('A bundle number must be finite.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError('A bundle value must be JSON.');
}

/** Lowercase hex SHA-256 of the UTF-8 text. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const isSensitive = (document: unknown): boolean =>
  document !== null &&
  typeof document === 'object' &&
  (document as Record<string, unknown>)['sensitivity'] === 'sensitive';

/** Sensitive Context in the Context records, or in a candidate of a Context conflict. */
function containsSensitiveContext(
  data: Readonly<Record<string, readonly BundleRecord[]>>,
): boolean {
  if ((data['contexts'] ?? []).some(({ document }) => isSensitive(document))) return true;
  return (data[bundleSupplementSections.conflictCandidates] ?? []).some(({ document }) => {
    if (document['entityType'] !== 'context') return false;
    const side = (value: unknown) =>
      value !== null && typeof value === 'object'
        ? isSensitive((value as Record<string, unknown>)['document'])
        : false;
    return isSensitive(document['base']) || side(document['local']) || side(document['remote']);
  });
}

function supplementRecords(input: EncodeBundleInput): ReadonlyMap<string, BundleRecord[]> {
  const settings = input.supplement.profileSettings;
  return new Map<string, BundleRecord[]>([
    [
      bundleSupplementSections.profileSettings,
      settings === null
        ? []
        : [
            {
              id: settings.profileId,
              revision: settings.localRevision,
              document: {
                preferredName: settings.preferredName,
                localeOverride: settings.localeOverride,
                ...(settings.deviceState === undefined
                  ? {}
                  : { deviceState: settings.deviceState }),
                ...(settings.onboardingDraft === undefined
                  ? {}
                  : { onboardingDraft: settings.onboardingDraft }),
                ...(settings.onboardingArtifacts === undefined
                  ? {}
                  : { onboardingArtifacts: settings.onboardingArtifacts }),
              },
            },
          ],
    ],
    [
      bundleSupplementSections.conflictCandidates,
      input.supplement.openConflicts.map((conflict) => ({
        id: conflict.conflictId,
        revision: conflict.localRevision,
        document: {
          entityType: conflict.entityType,
          entityId: conflict.entityId,
          kind: conflict.kind,
          fields: [...conflict.fields],
          base: conflict.base,
          local: { deleted: conflict.local.deleted, document: conflict.local.document },
          remote: { deleted: conflict.remote.deleted, document: conflict.remote.document },
          createdAt: conflict.createdAt,
        },
      })),
    ],
    [
      bundleSupplementSections.tombstones,
      (input.supplement.tombstones ?? []).map((row) => ({
        id: row.entityId,
        revision: row.localRevision,
        document: { entityType: row.entityType, entityId: row.entityId, deletedAt: row.deletedAt },
      })),
    ],
    [
      bundleSupplementSections.history,
      (input.supplement.history ?? []).map((row) => ({
        id: row.eventId,
        revision: row.localRevision,
        document: {
          entityType: row.entityType,
          entityId: row.entityId,
          eventType: row.eventType,
          actor: row.actor,
          occurredAt: row.occurredAt,
        },
      })),
    ],
  ]);
}

export class CanonicalBundleCodec implements CanonicalBundlePort, ImportBundleDecoder {
  async encode(input: EncodeBundleInput): Promise<EncodedBundle> {
    const sections = new Map<string, BundleRecord[]>(sectionNames.map((name) => [name, []]));
    for (const record of input.snapshot.records) {
      const section = sections.get(bundleSections[record.type]);
      if (section === undefined) throw new TypeError('Unknown bundle record type.');
      section.push({ id: record.id, revision: record.localRevision, document: record.document });
    }
    for (const [name, records] of supplementRecords(input)) sections.set(name, records);
    const data: Record<string, BundleRecord[]> = {};
    const recordCounts: Record<string, number> = {};
    for (const name of sectionNames) {
      const records = [...(sections.get(name) ?? [])].sort((left, right) =>
        compareText(left.id, right.id),
      );
      data[name] = records;
      recordCounts[name] = records.length;
    }
    const canonicalData = canonicalJson(data);
    const manifest: CanonicalBundleManifest = {
      sections: [...sectionNames],
      recordCounts,
      sourceMode: input.sourceMode,
      containsSensitiveContext: containsSensitiveContext(data),
      syncWasPending: input.syncWasPending,
      dataSha256: await sha256Hex(canonicalData),
    };
    const bundle = {
      format: canonicalBundleFormat,
      formatVersion: canonicalBundleFormatVersion,
      bundleId: input.bundleId,
      exportedAt: input.exportedAt,
      appVersion: input.appVersion,
      manifest,
      // The canonical form keeps every key sorted, so the same plan always reads the same.
      data: JSON.parse(canonicalData) as unknown,
    };
    return {
      bundleId: input.bundleId,
      exportedAt: input.exportedAt,
      manifest,
      recordCount: input.snapshot.records.length,
      text: `${JSON.stringify(bundle, null, 2)}\n`,
    };
  }

  async verify(text: string): Promise<BundleVerification> {
    if (!boundedJsonText(text)) return { ok: false, reason: 'invalid_structure' };
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    if (!boundedJsonTree(parsedJson)) return { ok: false, reason: 'invalid_structure' };
    if (
      parsedJson === null ||
      typeof parsedJson !== 'object' ||
      (parsedJson as Record<string, unknown>)['format'] !== canonicalBundleFormat ||
      (parsedJson as Record<string, unknown>)['formatVersion'] !== canonicalBundleFormatVersion
    ) {
      return { ok: false, reason: 'unsupported_format' };
    }
    const parsed = bundleSchema.safeParse(parsedJson);
    if (!parsed.success) return { ok: false, reason: 'invalid_structure' };
    const { manifest, data } = parsed.data;

    const dataSections = Object.keys(data).sort(compareText);
    const supportedSections = sameList(dataSections, legacySectionNames)
      ? legacySectionNames
      : sectionNames;
    if (
      !sameList(dataSections, supportedSections) ||
      !sameList(manifest.sections, supportedSections) ||
      !sameList(Object.keys(manifest.recordCounts).sort(compareText), supportedSections)
    ) {
      return { ok: false, reason: 'manifest_mismatch' };
    }
    let recordCount = 0;
    let allRecords = 0;
    for (const name of supportedSections) {
      const records = data[name] ?? [];
      allRecords += records.length;
      if (allRecords > importLimits.records) return { ok: false, reason: 'invalid_structure' };
      if (manifest.recordCounts[name] !== records.length) {
        return { ok: false, reason: 'count_mismatch' };
      }
      const type = typeBySection.get(name);
      // Planning records are counted; the supplement's sections are counted in the manifest.
      if (type !== undefined) recordCount += records.length;
      const schema = type === undefined ? supplementSchemas[name] : documentSchemas[type];
      if (schema === undefined) return { ok: false, reason: 'manifest_mismatch' };
      for (const [index, record] of records.entries()) {
        const previous = records[index - 1];
        if (previous !== undefined && compareText(previous.id, record.id) >= 0) {
          return { ok: false, reason: 'invalid_structure' };
        }
        if (!schema.safeParse(record.document).success || !validTimesAndZones(record.document)) {
          return { ok: false, reason: 'invalid_record' };
        }
        if (
          name === bundleSupplementSections.conflictCandidates &&
          !validConflictDocuments(record.document)
        )
          return { ok: false, reason: 'invalid_record' };
        if (
          name === bundleSupplementSections.tombstones &&
          record.document['entityId'] !== record.id
        )
          return { ok: false, reason: 'invalid_record' };
      }
    }
    // The Profile's settings belong to the bundle's one Profile.
    const settings = data[bundleSupplementSections.profileSettings] ?? [];
    const profiles = data[bundleSections.profile] ?? [];
    if (settings.length > 1 || settings.some(({ id }) => profiles[0]?.id !== id)) {
      return { ok: false, reason: 'invalid_structure' };
    }
    const canonicalKeys = new Set<string>();
    const canonicalIds = new Set<string>();
    for (const [section, type] of typeBySection) {
      for (const row of data[section] ?? []) {
        if (canonicalIds.has(row.id)) return { ok: false, reason: 'invalid_structure' };
        canonicalIds.add(row.id);
        canonicalKeys.add(`${type}:${row.id}`);
      }
    }
    for (const row of data[bundleSupplementSections.tombstones] ?? [])
      if (canonicalKeys.has(`${String(row.document['entityType'])}:${row.id}`))
        return { ok: false, reason: 'invalid_record' };
    if (manifest.containsSensitiveContext !== containsSensitiveContext(data)) {
      return { ok: false, reason: 'manifest_mismatch' };
    }
    if ((await sha256Hex(canonicalJson(data))) !== manifest.dataSha256) {
      return { ok: false, reason: 'digest_mismatch' };
    }
    return {
      ok: true,
      bundleId: parsed.data.bundleId as UUID,
      manifest,
      recordCount,
    };
  }

  async decode(text: string): Promise<ImportResult<ImportBundle>> {
    if (!boundedJsonText(text)) return { ok: false, code: 'input_limit' };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, code: 'invalid_bundle' };
    }
    if (!boundedJsonTree(raw)) return { ok: false, code: 'input_limit' };
    const verified = await this.verify(text);
    if (!verified.ok) {
      const code =
        verified.reason === 'unsupported_format'
          ? 'unsupported_format'
          : verified.reason === 'digest_mismatch'
            ? 'digest_mismatch'
            : verified.reason === 'invalid_record'
              ? 'invalid_record'
              : 'invalid_bundle';
      return { ok: false, code };
    }
    const parsed = bundleSchema.parse(raw);
    const records = [...typeBySection.entries()].flatMap(([section, type]) =>
      (parsed.data[section] ?? []).map((row) => ({
        type,
        id: row.id as UUID,
        localRevision: row.revision,
        document: row.document,
      })),
    );
    const settingsRow = parsed.data[bundleSupplementSections.profileSettings]?.[0];
    const settings =
      settingsRow === undefined ? null : profileSettingsDocumentSchema.parse(settingsRow.document);
    return {
      ok: true,
      value: {
        bundleId: verified.bundleId,
        exportedAt: parsed.exportedAt as Instant,
        records,
        containsSensitiveContext: verified.manifest.containsSensitiveContext,
        bytes: new TextEncoder().encode(text).byteLength,
        supplement: {
          profileSettings:
            settingsRow === undefined || settings === null
              ? null
              : ({
                  profileId: settingsRow.id as UUID,
                  localRevision: settingsRow.revision,
                  ...settings,
                } as unknown as NonNullable<ImportBundle['supplement']['profileSettings']>),
          openConflicts: (parsed.data[bundleSupplementSections.conflictCandidates] ?? []).map(
            (row) => {
              const doc = conflictCandidateDocumentSchema.parse(row.document);
              return {
                conflictId: row.id as UUID,
                localRevision: row.revision,
                entityType: doc.entityType,
                entityId: doc.entityId as UUID,
                kind: doc.kind,
                fields: doc.fields,
                base: doc.base,
                local: doc.local,
                remote: doc.remote,
                createdAt: doc.createdAt as Instant,
              };
            },
          ),
          tombstones: (parsed.data[bundleSupplementSections.tombstones] ?? []).map((row) => ({
            entityType: row.document['entityType'] as EntityType,
            entityId: row.id as UUID,
            localRevision: row.revision,
            deletedAt: row.document['deletedAt'] as Instant,
          })),
          history: (parsed.data[bundleSupplementSections.history] ?? []).map((row) => ({
            eventId: row.id as UUID,
            entityType: row.document['entityType'] as EntityType,
            entityId: row.document['entityId'] as UUID,
            localRevision: row.revision,
            eventType: row.document['eventType'] as string,
            actor: row.document['actor'] as 'user' | 'import' | 'sync' | 'intelligence_proposal',
            occurredAt: row.document['occurredAt'] as Instant,
          })),
        },
      },
    };
  }
}

function boundedJsonText(text: string): boolean {
  if (
    text.length > importLimits.bytes ||
    new TextEncoder().encode(text).byteLength > importLimits.bytes
  )
    return false;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      depth += 1;
      if (depth > importLimits.depth) return false;
    } else if (char === '}' || char === ']') depth -= 1;
  }
  return true;
}

function boundedJsonTree(root: unknown): boolean {
  const pending: unknown[] = [root];
  let nodes = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    nodes += 1;
    if (nodes > importLimits.nodes) return false;
    if (typeof value === 'string' && value.length > importLimits.stringLength) return false;
    if (Array.isArray(value)) {
      if (value.length > importLimits.records) return false;
      for (const child of value) pending.push(child);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') return false;
        pending.push(child);
      }
    }
  }
  return true;
}

function validTimesAndZones(root: unknown): boolean {
  if (Array.isArray(root)) return root.every(validTimesAndZones);
  if (root === null || typeof root !== 'object') return true;
  return Object.entries(root).every(([key, value]) => {
    if (typeof value === 'string') {
      if (/timeZone$/iu.test(key) && !parseIanaTimeZone(value).ok) return false;
      if (/^\d{4}-\d{2}-\d{2}T/u.test(value) && !parseInstant(value).ok) return false;
    }
    return validTimesAndZones(value);
  });
}

function validConflictDocuments(doc: Record<string, unknown>): boolean {
  const type = doc['entityType'] as EntityType;
  const schema = documentSchemas[type];
  if (schema === undefined) return false;
  if (doc['base'] !== null && !schema.safeParse(doc['base']).success) return false;
  for (const name of ['local', 'remote']) {
    const side = doc[name] as { deleted: boolean; document: unknown };
    if (
      side.deleted !== (side.document === null) ||
      (!side.deleted && !schema.safeParse(side.document).success)
    )
      return false;
  }
  return true;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
