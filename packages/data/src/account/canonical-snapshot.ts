import type {
  CanonicalRecordState,
  CanonicalSnapshot,
  CanonicalSnapshotRecord,
  PlanRecordCounts,
} from '@yelaxis/application';
import type { EntityRef, EntityType, OwnerId, UUID } from '@yelaxis/domain';

import type { CanonicalCodecRegistry } from '../application/canonical-codecs';
import { DataAdapterError } from '../application/errors';
import type { SqliteQueryConnection } from '../sqlite/driver';
import { readContextRecord } from './context-document';
import type { OwnedTable } from './owned-tables';

/** Where the records of one canonical entity type live. */
export interface SnapshotSource {
  readonly type: EntityType;
  readonly tables: readonly OwnedTable[];
  /**
   * Typed join rows are records in any state: their `deleted_at` is the document's `unlinkedAt`
   * Every other record is live while `deleted_at` is NULL.
   */
  readonly anyState: boolean;
}

const sources = [
  { type: 'action', tables: ['actions'], anyState: false },
  { type: 'axis', tables: ['axes'], anyState: false },
  { type: 'commitment', tables: ['commitments'], anyState: false },
  { type: 'constraint', tables: ['constraints'], anyState: false },
  { type: 'context', tables: ['contexts'], anyState: false },
  { type: 'direction', tables: ['year_directions'], anyState: false },
  // `day_focus` rows live in `focus_selections`, `week_commitment` rows in `week_selections`.
  { type: 'focus_selection', tables: ['focus_selections', 'week_selections'], anyState: false },
  { type: 'milestone', tables: ['milestones'], anyState: false },
  { type: 'milestone_action', tables: ['milestone_actions'], anyState: true },
  { type: 'milestone_project', tables: ['milestone_projects'], anyState: true },
  { type: 'note', tables: ['notes'], anyState: false },
  { type: 'outcome', tables: ['outcomes'], anyState: false },
  { type: 'planning_placement', tables: ['planning_placements'], anyState: false },
  { type: 'profile', tables: ['profiles'], anyState: false },
  { type: 'project', tables: ['projects'], anyState: false },
  { type: 'project_secondary_outcome', tables: ['project_secondary_outcomes'], anyState: true },
  { type: 'reminder', tables: ['reminders'], anyState: false },
  { type: 'review', tables: ['review_checkpoints'], anyState: false },
  { type: 'review_item', tables: ['review_items'], anyState: false },
  // A Routine's document includes its generations (`routine_generations`).
  { type: 'routine', tables: ['routines'], anyState: false },
  { type: 'routine_action_defaults', tables: ['routine_action_defaults'], anyState: false },
  { type: 'routine_occurrence', tables: ['routine_occurrences'], anyState: false },
  { type: 'template', tables: ['templates'], anyState: false },
  { type: 'theme', tables: ['month_themes'], anyState: false },
  { type: 'time_block', tables: ['time_blocks'], anyState: false },
] as const satisfies readonly SnapshotSource[];

type MissingSnapshotType = Exclude<EntityType, (typeof sources)[number]['type']>;
const snapshotTypeParity: [MissingSnapshotType] extends [never] ? true : never = true;
void snapshotTypeParity;

/** Every canonical entity type, sorted by type name: the order of snapshots and bundles. */
export const snapshotSources: readonly SnapshotSource[] = Object.freeze(
  sources.map((source) => Object.freeze(source)),
);

function idQuery(source: SnapshotSource): string {
  return source.tables
    .map(
      (table) =>
        `SELECT id FROM ${table} WHERE owner_id = ?${source.anyState ? '' : ' AND deleted_at IS NULL'}`,
    )
    .join(' UNION ALL ');
}

type RecordReader = (
  connection: SqliteQueryConnection,
  ref: EntityRef,
) => Promise<CanonicalRecordState | null>;

/**
 * The registry's codec for a type; Context has no registered codec yet, so its entries are read
 * through the account module's Context document until one is registered.
 */
function recordReader(codecs: CanonicalCodecRegistry, type: EntityType): RecordReader {
  try {
    const codec = codecs.resolve(type);
    return (connection, ref) => codec.read(connection, ref);
  } catch (error) {
    if (type === 'context' && error instanceof DataAdapterError) return readContextRecord;
    throw error;
  }
}

/**
 * Every canonical record of one owner through the codecs, sorted by type and then id. Run it inside
 * one transaction for a consistent snapshot.
 */
export async function readCanonicalSnapshot(
  connection: SqliteQueryConnection,
  codecs: CanonicalCodecRegistry,
  ownerId: OwnerId,
): Promise<CanonicalSnapshot> {
  const records: CanonicalSnapshotRecord[] = [];
  for (const source of snapshotSources) {
    const read = recordReader(codecs, source.type);
    const rows = await connection.all<{ id: string }>(
      `SELECT id FROM (${idQuery(source)}) ORDER BY id;`,
      source.tables.map(() => ownerId),
    );
    for (const { id } of rows) {
      const ref: EntityRef = { type: source.type, id: id as UUID, ownerId };
      const record = await read(connection, ref);
      if (record === null) throw new DataAdapterError('invalid_persisted_record');
      records.push({
        type: source.type,
        id: ref.id,
        localRevision: record.localRevision,
        document: record.document,
      });
    }
  }
  return { ownerId, records };
}

/** Record counts with the same membership as `readCanonicalSnapshot`, without decoding. */
export async function countCanonicalRecords(
  connection: SqliteQueryConnection,
  ownerId: OwnerId,
): Promise<PlanRecordCounts> {
  const byType: Partial<Record<EntityType, number>> = {};
  let total = 0;
  for (const source of snapshotSources) {
    const row = await connection.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM (${idQuery(source)});`,
      source.tables.map(() => ownerId),
    );
    const count = row?.count ?? 0;
    if (count > 0) byType[source.type] = count;
    total += count;
  }
  const sensitive = await connection.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM contexts
     WHERE owner_id = ? AND deleted_at IS NULL AND sensitivity = 'sensitive';`,
    [ownerId],
  );
  return { byType, total, sensitiveContextCount: sensitive?.count ?? 0 };
}
