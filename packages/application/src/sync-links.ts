/**
 * Typed links between synced records, read from documents the way the server's reference map
 * names them: a link field at the top level, inside a `target` object, or a
 * conversion (`convertedTo`). Used only to tell a person which record each version of a conflict
 * links to; sync decisions never depend on it.
 */
import type { EntityType, UUID } from '@yelaxis/domain';

import type { SyncConflictLink, SyncDocument } from './sync-contracts';
import type { SyncTransaction } from './sync-kit';

/** Link fields and the entity type each one names. */
const linkFields: Readonly<Record<string, EntityType>> = {
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
};

const conversionTypes: Readonly<Record<string, EntityType>> = { note: 'note', project: 'project' };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SyncDocumentLink {
  readonly entityType: EntityType;
  readonly id: UUID;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fieldLink(field: string, value: unknown): SyncDocumentLink | null {
  const entityType = Object.hasOwn(linkFields, field) ? linkFields[field] : undefined;
  if (entityType === undefined || typeof value !== 'string' || !uuidPattern.test(value)) {
    return null;
  }
  return { entityType, id: value as UUID };
}

/** The records a document links to. */
export function documentLinks(document: SyncDocument | null): readonly SyncDocumentLink[] {
  if (document === null) return [];
  const links: SyncDocumentLink[] = [];
  for (const [field, value] of Object.entries(document)) {
    const direct = fieldLink(field, value);
    if (direct !== null) {
      links.push(direct);
      continue;
    }
    if (!isRecord(value)) continue;
    if (field === 'convertedTo') {
      const type = value['type'];
      const id = value['id'];
      const entityType =
        typeof type === 'string' && Object.hasOwn(conversionTypes, type)
          ? conversionTypes[type]
          : undefined;
      if (entityType !== undefined && typeof id === 'string' && uuidPattern.test(id)) {
        links.push({ entityType, id: id as UUID });
      }
      continue;
    }
    for (const [inner, innerValue] of Object.entries(value)) {
      const nested = fieldLink(inner, innerValue);
      if (nested !== null) links.push(nested);
    }
  }
  return links;
}

/** How this device knows each record the given documents link to. */
export async function readConflictLinks(
  tx: SyncTransaction,
  documents: readonly (SyncDocument | null)[],
): Promise<Readonly<Record<string, SyncConflictLink>>> {
  const links: Record<string, SyncConflictLink> = {};
  for (const document of documents) {
    for (const link of documentLinks(document)) {
      if (Object.hasOwn(links, link.id)) continue;
      const ref = tx.ref(link.entityType, link.id);
      const row = await tx.unitOfWork.records.read(ref);
      if (row !== null) {
        const title = row.document['title'];
        links[link.id] = {
          entityType: link.entityType,
          presence: 'here',
          ...(typeof title === 'string' && title.trim().length > 0 ? { title } : {}),
        };
        continue;
      }
      const deletion = await tx.unitOfWork.sync.readDeletion(ref);
      links[link.id] = {
        entityType: link.entityType,
        presence: deletion === null ? 'missing' : 'deleted',
      };
    }
  }
  return links;
}
