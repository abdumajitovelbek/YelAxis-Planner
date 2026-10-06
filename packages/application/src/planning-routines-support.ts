import {
  deriveNameBasedUuid,
  normalizeActionInput,
  ok,
  yelaxisDerivedIdNamespace,
  type CommandId,
  type DomainError,
  type DomainResult,
  type EnergyLabel,
  type Instant,
  type OwnerId,
  type Priority,
  type UUID,
} from '@yelaxis/domain';

import type { ApplicationResult, CommandEnvelope, ExpectedRevision } from './contracts';
import type {
  PlanningQueryPort,
  RoutineActionDefaultsDocument,
  RoutineDefaultsInput,
} from './planning-contracts';
import { invalid, parseId } from './planning-kit';
import type { ApplicationDependencies } from './ports';

/** First order key for records created by a planning command (15 digits, sequential after it). */
export const initialOrderKey = '500000000000000';

const orderKeyBase = 500_000_000_000_000;

/** Sequential 15-digit order keys starting at {@link initialOrderKey}. */
export function createOrderKeySequence(): () => string {
  let index = 0;
  return () => {
    const value = String(orderKeyBase + index).padStart(15, '0');
    index += 1;
    return value;
  };
}

/** Resolve the active owner before any read; mirrors the identity failures of `executeCommand`. */
export async function resolveOwner(
  dependencies: ApplicationDependencies,
): Promise<ApplicationResult<OwnerId>> {
  try {
    const active = await dependencies.identityContext.getActiveIdentity();
    if (active === null) return { ok: false, error: { code: 'no_active_identity' } };
    return { ok: true, value: active.ownerId };
  } catch {
    return { ok: false, error: { code: 'identity_unavailable' } };
  }
}

export function userEnvelope<TInput>(
  dependencies: ApplicationDependencies,
  ownerId: OwnerId,
  commandId: CommandId | undefined,
  expectedRevisions: readonly ExpectedRevision[],
  input: TInput,
): CommandEnvelope<TInput> {
  return {
    commandId: commandId ?? dependencies.ids.next(),
    ownerId,
    actor: 'user',
    expectedRevisions,
    input,
  };
}

/** Domain rejection with a stable reason and optional extra details (never persisted). */
export function rejected(
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
  message = 'The planning request is invalid.',
): ApplicationResult<never> {
  return {
    ok: false,
    error: {
      code: 'domain_rejected',
      domainError: { code: 'invalid_value', message, details: { reason, ...details } },
    },
  };
}

export function transitionError(reason: string, message: string): DomainResult<never> {
  const error: DomainError = { code: 'invalid_transition', message, details: { reason } };
  return { ok: false, error };
}

/** Minimal syncable metadata so a new or updated document can be checked by domain validators. */
export function snapshotMetadata(
  id: UUID,
  ownerId: OwnerId,
  now: Instant,
  localRevision = 1,
): {
  readonly id: UUID;
  readonly ownerId: OwnerId;
  readonly localRevision: number;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
} {
  return { id, ownerId, localRevision, createdAt: now, updatedAt: now };
}

/** Derived, stable id of a Routine generation's action defaults. */
export const routineDefaultsId = (routineId: UUID, generation: number): UUID =>
  deriveNameBasedUuid(yelaxisDerivedIdNamespace, `routine-defaults:${routineId}:${generation}`);

export interface DefaultsFields {
  readonly projectId?: UUID;
  readonly note?: string;
  readonly estimateMinutes?: number;
  readonly energy?: EnergyLabel;
  readonly priority?: Priority;
}

export const hasDefaults = (fields: DefaultsFields): boolean => Object.keys(fields).length > 0;

export function defaultsDocument(
  routineId: UUID,
  generation: number,
  fields: DefaultsFields,
): RoutineActionDefaultsDocument {
  return { routineId, generation, ...fields };
}

/** Copy only the default fields from a stored defaults document. */
export function defaultsFieldsOf(document: Readonly<Record<string, unknown>>): DefaultsFields {
  const source = document as RoutineActionDefaultsDocument;
  return {
    ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
    ...(source.note === undefined ? {} : { note: source.note }),
    ...(source.estimateMinutes === undefined ? {} : { estimateMinutes: source.estimateMinutes }),
    ...(source.energy === undefined ? {} : { energy: source.energy }),
    ...(source.priority === undefined ? {} : { priority: source.priority }),
  };
}

/** Check that an optional reference names an active Axis or Project of this owner. */
export async function resolveActiveChoice(
  queries: PlanningQueryPort,
  ownerId: OwnerId,
  kind: 'axis' | 'project',
  value: string | undefined,
): Promise<DomainResult<UUID | undefined>> {
  const parsed = parseId(value);
  if (!parsed.ok) return parsed;
  if (parsed.value === undefined) return ok(undefined);
  const id = parsed.value;
  const choices =
    kind === 'axis' ? await queries.listAxes(ownerId) : await queries.listProjects(ownerId);
  return choices.some((choice) => choice.id === id) ? ok(id) : invalid(`${kind}_unavailable`);
}

export async function isActiveChoice(
  queries: PlanningQueryPort,
  ownerId: OwnerId,
  kind: 'axis' | 'project',
  id: UUID,
): Promise<boolean> {
  const choices =
    kind === 'axis' ? await queries.listAxes(ownerId) : await queries.listProjects(ownerId);
  return choices.some((choice) => choice.id === id);
}

/**
 * Validate optional repeating-item defaults with the same rules as Action fields: note up to 10,000
 * characters, estimate 1..10,080 minutes, known energy and priority labels, and an active Project.
 */
export async function resolveDefaults(
  queries: PlanningQueryPort,
  ownerId: OwnerId,
  input: RoutineDefaultsInput,
): Promise<DomainResult<DefaultsFields>> {
  const normalized = normalizeActionInput({
    title: 'defaults',
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.estimateMinutes === undefined ? {} : { estimateMinutes: input.estimateMinutes }),
    ...(input.energy === undefined || input.energy === '' ? {} : { energy: input.energy }),
    ...(input.priority === undefined || input.priority === '' ? {} : { priority: input.priority }),
  });
  if (!normalized.ok) return normalized;
  const project = await resolveActiveChoice(queries, ownerId, 'project', input.projectId);
  if (!project.ok) return project;
  const fields = normalized.value;
  return ok({
    ...(project.value === undefined ? {} : { projectId: project.value }),
    ...(fields.note === undefined ? {} : { note: fields.note }),
    ...(fields.estimateMinutes === undefined ? {} : { estimateMinutes: fields.estimateMinutes }),
    ...(fields.energy === undefined ? {} : { energy: fields.energy }),
    ...(fields.priority === undefined ? {} : { priority: fields.priority }),
  });
}
