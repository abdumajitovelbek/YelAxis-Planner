import type { ProfilePlanningDocument as ContractProfilePlanningDocument } from '@yelaxis/application';
import type { CommandContext, EntityRef } from '@yelaxis/domain';
import { z } from 'zod';

import type { SqliteQueryConnection } from '../sqlite/driver';
import {
  BaseCodec,
  ianaTimeZone,
  selectById,
  syncWhere,
  weekday,
  type Row,
  type SameKeys,
  type UpdateMutation,
} from './base-codec';
import { DataAdapterError } from './errors';

/**
 * The planning preferences of the one Profile row. Only these three columns are read or written
 * here; onboarding progress, names, and handbook state remain owned by the onboarding
 * persistence. A Profile is never created or permanently deleted through a planning command.
 */
export const profilePlanningDocumentSchema = z.strictObject({
  planningTimeZone: ianaTimeZone,
  weekStart: weekday,
  timeFormat: z.enum(['12_hour', '24_hour']),
});
export type ProfilePlanningDocument = z.infer<typeof profilePlanningDocumentSchema>;

const contractShape: true = true satisfies SameKeys<
  ProfilePlanningDocument,
  ContractProfilePlanningDocument
>;
void contractShape;

class ProfilePlanningCodec extends BaseCodec<ProfilePlanningDocument> {
  readonly entityType = 'profile' as const;
  readonly table = 'profiles';
  protected readonly schema = profilePlanningDocumentSchema;

  readDocument(connection: SqliteQueryConnection, ref: EntityRef) {
    return selectById(connection, this.table, ref);
  }

  protected decodeRow(row: Row) {
    return {
      planningTimeZone: row['planning_time_zone'],
      weekStart: row['week_start'],
      timeFormat: row['time_format'],
    };
  }

  create(): Promise<number> {
    return Promise.reject(new DataAdapterError('write_conflict'));
  }

  async update(
    connection: SqliteQueryConnection,
    mutation: UpdateMutation,
    context: CommandContext,
    document: ProfilePlanningDocument,
  ) {
    const result = await connection.run(
      `UPDATE profiles SET planning_time_zone = ?, week_start = ?, time_format = ?,
         updated_at = ?, client_updated_at = ?, local_revision = local_revision + 1
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL AND local_revision = ?
         AND server_revision = ? AND base_snapshot_hash IS ?;`,
      [
        document.planningTimeZone,
        document.weekStart,
        document.timeFormat,
        context.now,
        context.now,
        ...syncWhere(mutation),
      ],
    );
    return result.changes;
  }

  protected override delete(): Promise<number> {
    return Promise.reject(new DataAdapterError('write_conflict'));
  }
}

export const profilePlanningCodec = new ProfilePlanningCodec();
