import type { SqliteDriver } from '../sqlite/driver';
import {
  decodeTimeBlockTarget,
  type TimeBlockTarget,
  type TimeBlockTargetColumns,
} from '../sqlite/schema/records';

const maximumPageSize = 100;

function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumPageSize) {
    throw new RangeError(`Query limit must be between 1 and ${String(maximumPageSize)}`);
  }
  return limit;
}

export type InboxActionProjection = Readonly<{
  id: string;
  title: string;
  state: 'inbox';
  sortKey: string;
  localRevision: number;
}>;

type InboxActionRow = {
  id: string;
  title: string;
  state: 'inbox';
  sort_key: string;
  local_revision: number;
};

export async function listInboxActions(
  driver: SqliteDriver,
  input: Readonly<{
    ownerId: string;
    limit: number;
    after?: Readonly<{ sortKey: string; id: string }>;
  }>,
): Promise<InboxActionProjection[]> {
  const limit = checkedLimit(input.limit);
  const rows =
    input.after === undefined
      ? await driver.all<InboxActionRow>(
          `SELECT id, title, state, sort_key, local_revision
           FROM actions
           WHERE owner_id = ? AND state = 'inbox'
             AND archived_at IS NULL AND deleted_at IS NULL
           ORDER BY sort_key ASC, id ASC
           LIMIT ?;`,
          [input.ownerId, limit],
        )
      : await driver.all<InboxActionRow>(
          `SELECT id, title, state, sort_key, local_revision
           FROM actions
           WHERE owner_id = ? AND state = 'inbox'
             AND archived_at IS NULL AND deleted_at IS NULL
             AND (sort_key > ? OR (sort_key = ? AND id > ?))
           ORDER BY sort_key ASC, id ASC
           LIMIT ?;`,
          [input.ownerId, input.after.sortKey, input.after.sortKey, input.after.id, limit],
        );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    state: row.state,
    sortKey: row.sort_key,
    localRevision: row.local_revision,
  }));
}

type TimeBlockRow = TimeBlockTargetColumns & {
  id: string;
  starts_at_utc: string;
  ends_at_utc: string;
  time_zone: string;
  state: 'planned' | 'completed' | 'skipped' | 'canceled';
};

export type TimeBlockProjection = Readonly<{
  id: string;
  target: TimeBlockTarget;
  startsAtUtc: string;
  endsAtUtc: string;
  timeZone: string;
  state: TimeBlockRow['state'];
}>;

function projectTimeBlock(row: TimeBlockRow): TimeBlockProjection {
  return {
    id: row.id,
    target: decodeTimeBlockTarget(row),
    startsAtUtc: row.starts_at_utc,
    endsAtUtc: row.ends_at_utc,
    timeZone: row.time_zone,
    state: row.state,
  };
}

const timeBlockColumns = `
  id, action_id, routine_occurrence_id, commitment_id, custom_title,
  starts_at_utc, ends_at_utc, time_zone, state
`;

export async function listTimeBlocksInWindow(
  driver: SqliteDriver,
  input: Readonly<{
    ownerId: string;
    startsBeforeUtc: string;
    endsAfterUtc: string;
    limit: number;
    after?: Readonly<{ startsAtUtc: string; id: string }>;
  }>,
): Promise<TimeBlockProjection[]> {
  const limit = checkedLimit(input.limit);
  const rows =
    input.after === undefined
      ? await driver.all<TimeBlockRow>(
          `SELECT ${timeBlockColumns}
           FROM time_blocks
           WHERE owner_id = ? AND deleted_at IS NULL
             AND starts_at_utc < ? AND ends_at_utc > ?
           ORDER BY starts_at_utc ASC, id ASC
           LIMIT ?;`,
          [input.ownerId, input.startsBeforeUtc, input.endsAfterUtc, limit],
        )
      : await driver.all<TimeBlockRow>(
          `SELECT ${timeBlockColumns}
           FROM time_blocks
           WHERE owner_id = ? AND deleted_at IS NULL
             AND starts_at_utc < ? AND ends_at_utc > ?
             AND (starts_at_utc > ? OR (starts_at_utc = ? AND id > ?))
           ORDER BY starts_at_utc ASC, id ASC
           LIMIT ?;`,
          [
            input.ownerId,
            input.startsBeforeUtc,
            input.endsAfterUtc,
            input.after.startsAtUtc,
            input.after.startsAtUtc,
            input.after.id,
            limit,
          ],
        );

  return rows.map(projectTimeBlock);
}

export async function listActionBlockHistory(
  driver: SqliteDriver,
  input: Readonly<{
    ownerId: string;
    actionId: string;
    limit: number;
    before?: Readonly<{ startsAtUtc: string; id: string }>;
  }>,
): Promise<TimeBlockProjection[]> {
  const limit = checkedLimit(input.limit);
  const rows =
    input.before === undefined
      ? await driver.all<TimeBlockRow>(
          `SELECT ${timeBlockColumns}
           FROM time_blocks
           WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL
           ORDER BY starts_at_utc DESC, id DESC
           LIMIT ?;`,
          [input.ownerId, input.actionId, limit],
        )
      : await driver.all<TimeBlockRow>(
          `SELECT ${timeBlockColumns}
           FROM time_blocks
           WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL
             AND (starts_at_utc < ? OR (starts_at_utc = ? AND id < ?))
           ORDER BY starts_at_utc DESC, id DESC
           LIMIT ?;`,
          [
            input.ownerId,
            input.actionId,
            input.before.startsAtUtc,
            input.before.startsAtUtc,
            input.before.id,
            limit,
          ],
        );

  return rows.map(projectTimeBlock);
}

export type OutboxDispatchProjection = Readonly<{
  id: string;
  mutationGroupId: string;
  sequence: number;
  state: 'pending' | 'retry_wait';
}>;

type OutboxDispatchRow = {
  id: string;
  mutation_group_id: string;
  sequence: number;
  state: 'pending' | 'retry_wait';
};

export async function listOutboxDispatchPage(
  driver: SqliteDriver,
  input: Readonly<{
    ownerId: string;
    readyAt: string;
    limit: number;
    after?: Readonly<{ mutationGroupId: string; sequence: number; id: string }>;
  }>,
): Promise<OutboxDispatchProjection[]> {
  const limit = checkedLimit(input.limit);
  const rows =
    input.after === undefined
      ? await driver.all<OutboxDispatchRow>(
          `SELECT id, mutation_group_id, sequence, state
           FROM sync_outbox INDEXED BY idx_sync_outbox_dispatch
           WHERE owner_id = ? AND deleted_at IS NULL
             AND state IN ('pending', 'retry_wait')
             AND (state = 'pending' OR (state = 'retry_wait' AND next_attempt_at <= ?))
           ORDER BY mutation_group_id ASC, sequence ASC, id ASC
           LIMIT ?;`,
          [input.ownerId, input.readyAt, limit],
        )
      : await driver.all<OutboxDispatchRow>(
          `SELECT id, mutation_group_id, sequence, state
           FROM sync_outbox INDEXED BY idx_sync_outbox_dispatch
           WHERE owner_id = ? AND deleted_at IS NULL
             AND state IN ('pending', 'retry_wait')
             AND (state = 'pending' OR (state = 'retry_wait' AND next_attempt_at <= ?))
             AND (
               mutation_group_id > ? OR
               (mutation_group_id = ? AND sequence > ?) OR
               (mutation_group_id = ? AND sequence = ? AND id > ?)
             )
           ORDER BY mutation_group_id ASC, sequence ASC, id ASC
           LIMIT ?;`,
          [
            input.ownerId,
            input.readyAt,
            input.after.mutationGroupId,
            input.after.mutationGroupId,
            input.after.sequence,
            input.after.mutationGroupId,
            input.after.sequence,
            input.after.id,
            limit,
          ],
        );

  return rows.map((row) => ({
    id: row.id,
    mutationGroupId: row.mutation_group_id,
    sequence: row.sequence,
    state: row.state,
  }));
}
