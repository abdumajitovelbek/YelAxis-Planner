import { parseInstant, parseUUID, type DeletionTombstone, type EntityType } from '@yelaxis/domain';

import { DataAdapterError } from './errors';

const tombstoneKeys = ['deletedAt', 'entityId', 'entityType', 'ownerId', 'revision'] as const;

/**
 * Validates and copies the permanent-deletion wire record before it reaches storage.
 * Requiring ordinary data properties and an exact key set prevents deleted content
 * from being smuggled into an outbox payload through structural TypeScript typing.
 */
export function parseMinimalDeletionTombstone(value: unknown): DeletionTombstone {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw new DataAdapterError('write_conflict');
    }

    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== tombstoneKeys.length ||
      tombstoneKeys.some((key) => !ownKeys.includes(key))
    ) {
      throw new DataAdapterError('write_conflict');
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      tombstoneKeys.some((key) => {
        const descriptor = descriptors[key];
        return descriptor === undefined || !('value' in descriptor);
      })
    ) {
      throw new DataAdapterError('write_conflict');
    }

    const record = value as Record<(typeof tombstoneKeys)[number], unknown>;
    const ownerId = parseCanonicalUuid(record.ownerId);
    const entityId = parseCanonicalUuid(record.entityId);
    const entityType = record.entityType;
    const revision = record.revision;
    const deletedAt = record.deletedAt;
    const parsedInstant = typeof deletedAt === 'string' ? parseInstant(deletedAt) : undefined;

    if (
      typeof entityType !== 'string' ||
      !Number.isSafeInteger(revision) ||
      (revision as number) < 1 ||
      parsedInstant === undefined ||
      !parsedInstant.ok ||
      parsedInstant.value !== deletedAt
    ) {
      throw new DataAdapterError('write_conflict');
    }

    return {
      ownerId,
      entityType: entityType as EntityType,
      entityId,
      revision: revision as number,
      deletedAt: parsedInstant.value,
    };
  } catch (error) {
    if (error instanceof DataAdapterError) throw error;
    throw new DataAdapterError('write_conflict');
  }
}

function parseCanonicalUuid(value: unknown) {
  if (typeof value !== 'string') throw new DataAdapterError('write_conflict');
  const parsed = parseUUID(value);
  if (!parsed.ok || parsed.value !== value) throw new DataAdapterError('write_conflict');
  return parsed.value;
}
