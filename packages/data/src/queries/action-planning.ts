import type {
  ActionChoice,
  ActionDeleteImpact,
  ActionPlanningQueryPort,
  ActionWorkspace,
  CanonicalRecordState,
  InboxPage,
  ProfilePlanningContext,
} from '@yelaxis/application';
import type { EntityRef, Instant, IanaTimeZone, OwnerId, UUID, Weekday } from '@yelaxis/domain';

import { createDefaultCanonicalCodecRegistry } from '../application/canonical-codecs';
import { DataAdapterError } from '../application/errors';
import type { SqliteDriver } from '../sqlite/driver';
import { readReviewItemReferences } from './alignment-queries';

const maximumPage = 100;

/** An active Milestone offered by the Inbox Plan triage, with its Outcome title. */
export type ActionMilestoneChoice = ActionChoice & {
  readonly outcomeId: UUID;
  readonly outcomeTitle: string;
};

/** A Project choice; `axisId` lets the form ask before a cross-Axis link. */
export type ActionProjectChoice = ActionChoice & { readonly axisId?: UUID };

/**
 * Action delete impact plus the Action's unlinked Milestone rows, removed with it,
 * and the review items that name it, kept with a cleared reference.
 */
export type ActionDeleteImpactRecords = ActionDeleteImpact & {
  readonly inactiveMilestoneLinks: CanonicalRecordState[];
};

export class SqliteActionPlanningQueries implements ActionPlanningQueryPort {
  readonly #codecs = createDefaultCanonicalCodecRegistry();

  constructor(private readonly driver: SqliteDriver) {}

  async getProfileContext(ownerId: OwnerId): Promise<ProfilePlanningContext> {
    const row = await this.driver.get<{
      id: string;
      planning_time_zone: string | null;
      week_start: string | null;
    }>(
      `SELECT id, planning_time_zone, week_start FROM profiles
       WHERE owner_id = ? AND deleted_at IS NULL LIMIT 1;`,
      [ownerId],
    );
    if (row === undefined || row.planning_time_zone === null || row.week_start === null) {
      throw new DataAdapterError('invalid_identity_record');
    }
    return {
      profileId: row.id as UUID,
      planningTimeZone: row.planning_time_zone as IanaTimeZone,
      weekStart: row.week_start as Weekday,
    };
  }

  async getInboxEdge(ownerId: OwnerId, edge: 'first' | 'last'): Promise<string | null> {
    const row = await this.driver.get<{ sort_key: string }>(
      `SELECT sort_key FROM actions
       WHERE owner_id = ? AND state = 'inbox' AND archived_at IS NULL AND deleted_at IS NULL
       ORDER BY sort_key ${edge === 'first' ? 'ASC' : 'DESC'}, id ${edge === 'first' ? 'ASC' : 'DESC'}
       LIMIT 1;`,
      [ownerId],
    );
    return row?.sort_key ?? null;
  }

  async listInbox(
    ownerId: OwnerId,
    input: {
      readonly limit: number;
      readonly after?: { readonly sortKey: string; readonly id: UUID };
    },
  ): Promise<InboxPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > maximumPage) {
      throw new RangeError('Inbox page must contain between 1 and 100 rows.');
    }
    type Row = {
      id: string;
      title: string;
      state: 'inbox';
      sort_key: string;
      local_revision: number;
      created_at: string;
      due_date: string | null;
      due_at_utc: string | null;
      due_time_zone: string | null;
      estimate_minutes: number | null;
      energy: 'low' | 'medium' | 'high' | 'focused' | null;
      priority: 'low' | 'normal' | 'high' | null;
    };
    const parameters: unknown[] = [ownerId];
    const cursor =
      input.after === undefined ? '' : `AND (sort_key > ? OR (sort_key = ? AND id > ?))`;
    if (input.after !== undefined) {
      parameters.push(input.after.sortKey, input.after.sortKey, input.after.id);
    }
    parameters.push(input.limit + 1);
    const rows = await this.driver.all<Row>(
      `SELECT id, title, state, sort_key, local_revision, created_at, due_date,
              due_at_utc, due_time_zone, estimate_minutes, energy, priority
       FROM actions INDEXED BY idx_actions_inbox_order
       WHERE owner_id = ? AND state = 'inbox' AND archived_at IS NULL AND deleted_at IS NULL
         ${cursor}
       ORDER BY sort_key ASC, id ASC LIMIT ?;`,
      parameters as never[],
    );
    const count = await this.driver.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM actions
       WHERE owner_id = ? AND state = 'inbox' AND archived_at IS NULL AND deleted_at IS NULL;`,
      [ownerId],
    );
    const pageRows = rows.slice(0, input.limit);
    const items = pageRows.map((row) => ({
      id: row.id as UUID,
      title: row.title,
      state: row.state,
      sortKey: row.sort_key,
      localRevision: row.local_revision,
      createdAt: row.created_at as Instant,
      ...(row.due_date !== null
        ? { due: { kind: 'date' as const, date: row.due_date as never } }
        : row.due_at_utc !== null && row.due_time_zone !== null
          ? {
              due: {
                kind: 'instant' as const,
                instant: row.due_at_utc as Instant,
                authoredTimeZone: row.due_time_zone as IanaTimeZone,
              },
            }
          : {}),
      ...(row.estimate_minutes === null ? {} : { estimateMinutes: row.estimate_minutes }),
      ...(row.energy === null ? {} : { energy: row.energy }),
      ...(row.priority === null ? {} : { priority: row.priority }),
    }));
    const last = items.at(-1);
    return {
      items,
      total: count?.count ?? 0,
      ...(rows.length > input.limit && last !== undefined
        ? { nextCursor: { sortKey: last.sortKey, id: last.id } }
        : {}),
    };
  }

  async listAllInbox(
    ownerId: OwnerId,
  ): Promise<readonly { readonly ref: EntityRef<'action'>; readonly revision: number }[]> {
    const rows = await this.driver.all<{ id: string; local_revision: number }>(
      `SELECT id, local_revision FROM actions INDEXED BY idx_actions_inbox_order
       WHERE owner_id = ? AND state = 'inbox' AND archived_at IS NULL AND deleted_at IS NULL
       ORDER BY sort_key ASC, id ASC;`,
      [ownerId],
    );
    return rows.map((row) => ({
      ref: { type: 'action', id: row.id as UUID, ownerId },
      revision: row.local_revision,
    }));
  }

  async getActionWorkspace(ownerId: OwnerId, actionId: UUID): Promise<ActionWorkspace | null> {
    const actionRef = { type: 'action', id: actionId, ownerId } as const;
    const action = await this.#codecs.resolve('action').read(this.driver, actionRef);
    if (action === null) return null;
    const row = await this.driver.get<{
      created_at: string;
      axis_title: string | null;
      project_title: string | null;
    }>(
      `SELECT a.created_at, x.title AS axis_title, p.title AS project_title
       FROM actions a
       LEFT JOIN axes x ON x.owner_id = a.owner_id AND x.id = a.axis_id AND x.deleted_at IS NULL
       LEFT JOIN projects p ON p.owner_id = a.owner_id AND p.id = a.project_id AND p.deleted_at IS NULL
       WHERE a.owner_id = ? AND a.id = ? AND a.deleted_at IS NULL;`,
      [ownerId, actionId],
    );
    if (row === undefined) return null;
    const placementId = await this.driver.get<{ id: string }>(
      `SELECT id FROM planning_placements WHERE owner_id = ? AND action_id = ?
       AND archived_at IS NULL AND deleted_at IS NULL LIMIT 1;`,
      [ownerId, actionId],
    );
    const blockId = await this.driver.get<{ id: string }>(
      `SELECT id FROM time_blocks WHERE owner_id = ? AND action_id = ?
       AND state = 'planned' AND deleted_at IS NULL LIMIT 1;`,
      [ownerId, actionId],
    );
    const reminderId = await this.driver.get<{ id: string }>(
      `SELECT id FROM reminders WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL
       ORDER BY CASE state WHEN 'scheduled' THEN 0 WHEN 'delivered' THEN 1 ELSE 2 END,
                updated_at DESC, id DESC LIMIT 1;`,
      [ownerId, actionId],
    );
    return {
      action,
      createdAt: row.created_at as Instant,
      placement: await this.#readOptional('planning_placement', placementId?.id, ownerId),
      plannedBlock: await this.#readOptional('time_block', blockId?.id, ownerId),
      reminder: await this.#readOptional('reminder', reminderId?.id, ownerId),
      ...(row.axis_title === null ? {} : { axisTitle: row.axis_title }),
      ...(row.project_title === null ? {} : { projectTitle: row.project_title }),
    };
  }

  async getActionDeleteImpact(
    ownerId: OwnerId,
    actionId: UUID,
  ): Promise<ActionDeleteImpactRecords> {
    // The browser adapter owns one SQLite worker connection. Keep these reads ordered so the
    // delete preview cannot race multiple requests into the same connection.
    const placements = await this.#ids(
      `SELECT id FROM planning_placements WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL;`,
      [ownerId, actionId],
    );
    const reminders = await this.#ids(
      `SELECT id FROM reminders WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL;`,
      [ownerId, actionId],
    );
    // A Review reminder on one of the Action's blocks leaves with the Action too: the block stays
    // only as private-safe "Deleted Action" history.
    const blockReminders = await this.#ids(
      `SELECT id FROM reminders INDEXED BY idx_reminders_time_block
       WHERE owner_id = ? AND deleted_at IS NULL AND time_block_id IN (
         SELECT id FROM time_blocks WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL
       ) ORDER BY id;`,
      [ownerId, ownerId, actionId],
    );
    const dayFocus = await this.#ids(
      `SELECT id FROM focus_selections WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL;`,
      [ownerId, actionId],
    );
    const weekFocus = await this.#ids(
      `SELECT id FROM week_selections WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL;`,
      [ownerId, actionId],
    );
    const blocks = await this.#ids(
      `SELECT id FROM time_blocks WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL;`,
      [ownerId, actionId],
    );
    const milestone = await this.driver.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM milestone_actions INDEXED BY idx_milestone_actions_action
       WHERE owner_id = ? AND action_id = ? AND deleted_at IS NULL;`,
      [ownerId, actionId],
    );
    // Unlinked rows still hold the RESTRICT foreign key, so they leave with the Action.
    const inactiveLinks = await this.#ids(
      `SELECT id FROM milestone_actions INDEXED BY idx_milestone_actions_action
       WHERE owner_id = ? AND action_id = ? AND deleted_at IS NOT NULL ORDER BY id;`,
      [ownerId, actionId],
    );
    // Review decisions about the Action are kept with a cleared reference.
    const reviews = await readReviewItemReferences(this.driver, ownerId, {
      type: 'action',
      id: actionId,
      ownerId,
    });
    return {
      placements: await this.#readMany('planning_placement', placements, ownerId),
      reminders: await this.#readMany('reminder', [...reminders, ...blockReminders], ownerId),
      focusSelections: await this.#readMany(
        'focus_selection',
        [...dayFocus, ...weekFocus],
        ownerId,
      ),
      timeBlocks: await this.#readMany('time_block', blocks, ownerId),
      milestoneLinkCount: milestone?.count ?? 0,
      inactiveMilestoneLinks: await this.#readMany('milestone_action', inactiveLinks, ownerId),
      reviewItems: reviews.items,
      reviewReferences: reviews.total,
    };
  }

  /**
   * Active Milestones for the Inbox Plan picker, grouped by their Outcome's order and then in their
   * own order, with the Outcome title. Archived, completed, and canceled Milestones are not offered.
   */
  async listMilestones(ownerId: OwnerId): Promise<ActionMilestoneChoice[]> {
    const rows = await this.driver.all<{
      id: string;
      title: string;
      local_revision: number;
      outcome_id: string;
      outcome_title: string;
    }>(
      `SELECT m.id, m.title, m.local_revision, m.outcome_id, o.title AS outcome_title
       FROM milestones m
       JOIN outcomes o ON o.owner_id = m.owner_id AND o.id = m.outcome_id AND o.deleted_at IS NULL
       WHERE m.owner_id = ? AND m.state = 'active' AND m.archived_at IS NULL
         AND m.deleted_at IS NULL
       ORDER BY o.sort_key ASC, o.id ASC, m.sort_key ASC, m.id ASC;`,
      [ownerId],
    );
    return rows.map((row) => ({
      id: row.id as UUID,
      title: row.title,
      localRevision: row.local_revision,
      outcomeId: row.outcome_id as UUID,
      outcomeTitle: row.outcome_title,
    }));
  }

  /** The one Milestone link row of a pair in any state (active or unlinked), or null. */
  async findMilestoneActionLink(
    ownerId: OwnerId,
    milestoneId: UUID,
    actionId: UUID,
  ): Promise<CanonicalRecordState | null> {
    const row = await this.driver.get<{ id: string }>(
      `SELECT id FROM milestone_actions
       WHERE owner_id = ? AND milestone_id = ? AND action_id = ? LIMIT 1;`,
      [ownerId, milestoneId, actionId],
    );
    return this.#readOptional('milestone_action', row?.id, ownerId);
  }

  listAxes(ownerId: OwnerId): Promise<readonly ActionChoice[]> {
    return this.#choices('axes', ownerId, `state = 'active'`);
  }

  async listProjects(ownerId: OwnerId): Promise<ActionProjectChoice[]> {
    const rows = await this.driver.all<{
      id: string;
      title: string;
      local_revision: number;
      axis_id: string | null;
    }>(
      `SELECT id, title, local_revision, axis_id FROM projects
       WHERE owner_id = ? AND state IN ('idea', 'active', 'blocked', 'paused')
         AND archived_at IS NULL AND deleted_at IS NULL
       ORDER BY sort_key ASC, id ASC;`,
      [ownerId],
    );
    return rows.map((row) => ({
      id: row.id as UUID,
      title: row.title,
      localRevision: row.local_revision,
      ...(row.axis_id === null ? {} : { axisId: row.axis_id as UUID }),
    }));
  }

  async #choices(
    table: 'axes',
    ownerId: OwnerId,
    predicate: string,
  ): Promise<readonly ActionChoice[]> {
    const rows = await this.driver.all<{ id: string; title: string; local_revision: number }>(
      `SELECT id, title, local_revision FROM ${table}
       WHERE owner_id = ? AND ${predicate} AND archived_at IS NULL AND deleted_at IS NULL
       ORDER BY sort_key ASC, id ASC;`,
      [ownerId],
    );
    return rows.map((row) => ({
      id: row.id as UUID,
      title: row.title,
      localRevision: row.local_revision,
    }));
  }

  async #ids(sql: string, parameters: readonly unknown[]): Promise<string[]> {
    const rows = await this.driver.all<{ id: string }>(sql, parameters as never[]);
    return rows.map(({ id }) => id);
  }

  async #readOptional(type: EntityRef['type'], id: string | undefined, ownerId: OwnerId) {
    if (id === undefined) return null;
    return this.#codecs.resolve(type).read(this.driver, { type, id: id as UUID, ownerId });
  }

  async #readMany(type: EntityRef['type'], ids: readonly string[], ownerId: OwnerId) {
    const result = [];
    for (const id of ids) {
      const record = await this.#readOptional(type, id, ownerId);
      if (record !== null) result.push(record);
    }
    return result;
  }
}
