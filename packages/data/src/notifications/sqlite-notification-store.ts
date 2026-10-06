import type {
  NotificationCandidate,
  NotificationCentreItem,
  NotificationDeliveryStatus,
  NotificationKey,
  NotificationPreferences,
  NotificationReceipt,
  NotificationStorePort,
  NotificationTransaction,
  RoutineDocument,
  RoutineNotificationDefinition,
} from '@yelaxis/application';
import {
  addDays,
  createEntityRef,
  localDateOf,
  parseIanaTimeZone,
  parseInstant,
  parseUUID,
  projectRoutineOccurrences,
  type CalendarDate,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import { DataAdapterError } from '../application/errors';
import { SqlitePlanningQueries } from '../queries/planning-queries';
import type { SqliteDriver, SqliteQueryConnection } from '../sqlite/driver';

type CandidateRow = {
  id: UUID;
  local_revision: number;
  remind_at_utc: Instant;
  action_id: UUID | null;
  time_block_id: UUID | null;
  review_id: UUID | null;
  title: string;
  starts_at_utc: Instant | null;
  time_zone: string;
  review_type: 'daily' | 'weekly' | 'monthly' | 'yearly' | null;
  period_start_date: CalendarDate | null;
};
const candidateFrom = (row: CandidateRow): NotificationCandidate => ({
  reminderId: row.id,
  reminderRevision: row.local_revision,
  occurrenceKey: '',
  dueAt: row.remind_at_utc,
  title: row.title,
  href:
    row.action_id !== null
      ? `/actions/${row.action_id}`
      : row.time_block_id !== null
        ? `/plan/day/${localDateOf(row.starts_at_utc ?? row.remind_at_utc, row.time_zone as Parameters<typeof localDateOf>[1])}`
        : row.review_type === 'daily'
          ? `/end-day/${row.period_start_date ?? ''}`
          : `/review/${row.review_type ?? 'weekly'}/${row.review_type === 'monthly' ? (row.period_start_date?.slice(0, 7) ?? '') : row.review_type === 'yearly' ? (row.period_start_date?.slice(0, 4) ?? '') : (row.period_start_date ?? '')}`,
});
const candidateSelect = `SELECT r.id, r.local_revision, r.remind_at_utc, r.action_id, r.time_block_id, r.review_id,
  COALESCE(a.title, b.custom_title, ba.title, c.title, br.title, v.review_type || ' review', 'Reminder') AS title,
  b.starts_at_utc, COALESCE(b.time_zone, r.time_zone) AS time_zone, v.review_type, v.period_start_date
  FROM reminders r
  LEFT JOIN actions a ON a.owner_id = r.owner_id AND a.id = r.action_id AND a.deleted_at IS NULL
  LEFT JOIN time_blocks b ON b.owner_id = r.owner_id AND b.id = r.time_block_id AND b.deleted_at IS NULL
  LEFT JOIN actions ba ON ba.owner_id = r.owner_id AND ba.id = b.action_id AND ba.deleted_at IS NULL
  LEFT JOIN commitments c ON c.owner_id = r.owner_id AND c.id = b.commitment_id AND c.deleted_at IS NULL
  LEFT JOIN routine_occurrences bo ON bo.owner_id = r.owner_id AND bo.id = b.routine_occurrence_id AND bo.deleted_at IS NULL
  LEFT JOIN routines br ON br.owner_id = r.owner_id AND br.id = bo.routine_id AND br.deleted_at IS NULL
  LEFT JOIN review_checkpoints v ON v.owner_id = r.owner_id AND v.id = r.review_id AND v.deleted_at IS NULL`;
const eligible = `r.state = 'scheduled' AND r.deleted_at IS NULL AND (
  (r.action_id IS NOT NULL AND a.state IN ('inbox', 'planned', 'in_progress', 'scheduled')) OR
  (r.time_block_id IS NOT NULL AND b.state = 'planned' AND b.superseded_by_id IS NULL
    AND (b.custom_title IS NOT NULL OR ba.state IN ('inbox', 'planned', 'in_progress', 'scheduled')
      OR c.state = 'planned' OR (bo.state = 'planned' AND br.state = 'active'))) OR
  (r.review_id IS NOT NULL AND v.state IN ('draft', 'skipped') AND v.archived_at IS NULL))`;
const parametersFor = (ownerId: OwnerId, key: NotificationKey) =>
  [ownerId, key.reminderId, key.reminderRevision, key.occurrenceKey] as const;
const keyWhere =
  'owner_id = ? AND reminder_id = ? AND reminder_revision = ? AND occurrence_key = ?';

class Transaction implements NotificationTransaction {
  constructor(private readonly connection: SqliteQueryConnection) {}
  async setPreferences(
    ownerId: OwnerId,
    value: NotificationPreferences,
    now: Instant,
  ): Promise<void> {
    await this.connection.run(
      `INSERT INTO notification_preferences (owner_id, alerts_enabled, privacy_mode, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET alerts_enabled = excluded.alerts_enabled, privacy_mode = excluded.privacy_mode, updated_at = excluded.updated_at;`,
      [ownerId, Number(value.alertsEnabled), Number(value.privacyMode), now],
    );
  }
  async claim(ownerId: OwnerId, receipt: NotificationReceipt): Promise<boolean> {
    const result = await this.connection.run(
      `INSERT INTO notification_receipts (owner_id, reminder_id, reminder_revision, occurrence_key, due_at, observed_at, delivery_status, read_at, dismissed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT(owner_id, reminder_id, reminder_revision, occurrence_key) DO NOTHING;`,
      [
        ...parametersFor(ownerId, receipt),
        receipt.dueAt,
        receipt.observedAt,
        receipt.deliveryStatus,
      ],
    );
    return result.changes === 1;
  }
  async setDeliveryStatus(
    ownerId: OwnerId,
    key: NotificationKey,
    status: NotificationDeliveryStatus,
  ): Promise<void> {
    await this.connection.run(
      `UPDATE notification_receipts SET delivery_status = ? WHERE ${keyWhere};`,
      [status, ...parametersFor(ownerId, key)],
    );
  }
  async markRead(ownerId: OwnerId, key: NotificationKey, now: Instant): Promise<void> {
    await this.connection.run(
      `UPDATE notification_receipts SET read_at = COALESCE(read_at, ?) WHERE ${keyWhere};`,
      [now, ...parametersFor(ownerId, key)],
    );
  }
  async dismiss(ownerId: OwnerId, key: NotificationKey, now: Instant): Promise<void> {
    await this.connection.run(
      `UPDATE notification_receipts SET dismissed_at = ?, read_at = COALESCE(read_at, ?) WHERE ${keyWhere};`,
      [now, now, ...parametersFor(ownerId, key)],
    );
  }
  async setRoutineCursor(
    ownerId: OwnerId,
    definition: RoutineNotificationDefinition,
    nextDate: CalendarDate,
  ): Promise<void> {
    await this.connection.run(
      `INSERT INTO notification_routine_cursors (owner_id, reminder_id, reminder_revision, next_date) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, reminder_id, reminder_revision) DO UPDATE SET next_date = excluded.next_date;`,
      [ownerId, definition.reminderId, definition.reminderRevision, nextDate],
    );
  }
}

export class SqliteNotificationStore implements NotificationStorePort {
  readonly #queries: SqlitePlanningQueries;
  readonly #quarantined = new Map<OwnerId, number>();
  getQuarantinedReceiptCount(ownerId: OwnerId): number {
    return this.#quarantined.get(ownerId) ?? 0;
  }
  constructor(private readonly driver: SqliteDriver) {
    this.#queries = new SqlitePlanningQueries(driver);
  }
  transaction<T>(work: (transaction: NotificationTransaction) => Promise<T>): Promise<T> {
    return this.driver.transaction((connection) => work(new Transaction(connection)));
  }
  async getPreferences(ownerId: OwnerId): Promise<NotificationPreferences> {
    const row = await this.driver.get<{ alerts_enabled: number; privacy_mode: number }>(
      'SELECT alerts_enabled, privacy_mode FROM notification_preferences WHERE owner_id = ?;',
      [ownerId],
    );
    return row === undefined
      ? { alertsEnabled: false, privacyMode: true }
      : { alertsEnabled: row.alerts_enabled === 1, privacyMode: row.privacy_mode === 1 };
  }
  async listDue(
    ownerId: OwnerId,
    now: Instant,
    limit: number,
  ): Promise<readonly NotificationCandidate[]> {
    const rows = await this.driver.all<CandidateRow>(
      `${candidateSelect} WHERE r.owner_id = ? AND ${eligible} AND r.remind_at_utc <= ?
      AND NOT EXISTS (SELECT 1 FROM notification_receipts n WHERE n.owner_id = r.owner_id AND n.reminder_id = r.id AND n.reminder_revision = r.local_revision AND n.occurrence_key = '')
      ORDER BY r.remind_at_utc, r.id LIMIT ?;`,
      [ownerId, now, Math.min(50, Math.max(1, limit))],
    );
    return rows.map(candidateFrom);
  }
  async listRoutines(
    ownerId: OwnerId,
    afterId: UUID | null,
    limit: number,
  ): Promise<readonly RoutineNotificationDefinition[]> {
    const rows = await this.driver.all<{
      id: UUID;
      local_revision: number;
      routine_id: UUID;
      remind_at_utc: Instant;
      offset_minutes: number;
      next_date: CalendarDate | null;
    }>(
      `SELECT r.id, r.local_revision, r.routine_id, r.remind_at_utc, r.offset_minutes, n.next_date
      FROM reminders r JOIN routines t ON t.owner_id = r.owner_id AND t.id = r.routine_id
      LEFT JOIN notification_routine_cursors n ON n.owner_id = r.owner_id AND n.reminder_id = r.id AND n.reminder_revision = r.local_revision
      WHERE r.owner_id = ? AND r.state = 'scheduled' AND r.deleted_at IS NULL AND r.schedule_kind = 'relative'
        AND t.state = 'active' AND t.deleted_at IS NULL AND (? IS NULL OR r.id > ?)
      ORDER BY r.id LIMIT ?;`,
      [ownerId, afterId, afterId, Math.min(50, Math.max(1, limit))],
    );
    const result: RoutineNotificationDefinition[] = [];
    for (const row of rows) {
      const routine = await this.#queries.readRecord(
        ownerId,
        createEntityRef('routine', row.routine_id, ownerId),
      );
      if (routine !== null)
        result.push({
          reminderId: row.id,
          reminderRevision: row.local_revision,
          routineId: row.routine_id,
          document: routine.document as RoutineDocument,
          dueAt: row.remind_at_utc,
          offsetMinutes: row.offset_minutes,
          nextDate: row.next_date,
        });
    }
    return result;
  }
  async getPlanningZone(ownerId: OwnerId) {
    const row = await this.driver.get<{ planning_time_zone: string }>(
      'SELECT planning_time_zone FROM profiles WHERE owner_id = ? AND deleted_at IS NULL LIMIT 1;',
      [ownerId],
    );
    const parsed = row === undefined ? null : parseIanaTimeZone(row.planning_time_zone);
    if (parsed === null || !parsed.ok) throw new DataAdapterError('invalid_persisted_record');
    return parsed.value;
  }
  getMaterialized(ownerId: OwnerId, routineId: UUID, start: CalendarDate, end: CalendarDate) {
    return this.#queries.listMaterializedOccurrences(ownerId, { start, end }, routineId);
  }
  async resolve(ownerId: OwnerId, key: NotificationKey): Promise<NotificationCandidate | null> {
    if (key.occurrenceKey === '') {
      const row = await this.driver.get<CandidateRow>(
        `${candidateSelect} WHERE r.owner_id = ? AND r.id = ? AND r.local_revision = ? AND ${eligible};`,
        [ownerId, key.reminderId, key.reminderRevision],
      );
      return row === undefined ? null : candidateFrom(row);
    }
    const definition = await this.driver.get<{
      routine_id: UUID;
      remind_at_utc: Instant;
      offset_minutes: number;
    }>(
      `SELECT routine_id, remind_at_utc, offset_minutes FROM reminders
      WHERE owner_id = ? AND id = ? AND local_revision = ? AND state = 'scheduled' AND deleted_at IS NULL;`,
      [ownerId, key.reminderId, key.reminderRevision],
    );
    const receipt = await this.driver.get<{ due_at: Instant }>(
      `SELECT due_at FROM notification_receipts WHERE ${keyWhere};`,
      parametersFor(ownerId, key),
    );
    if (definition === undefined || receipt === undefined) return null;
    const routine = await this.#queries.readRecord(
      ownerId,
      createEntityRef('routine', definition.routine_id, ownerId),
    );
    if (routine === null) return null;
    const document = routine.document as RoutineDocument;
    if (document.state !== 'active') return null;
    const zone = await this.getPlanningZone(ownerId);
    const anchorDate = localDateOf(receipt.due_at, zone);
    const window = { start: addDays(anchorDate, -2), end: addDays(anchorDate, 9) };
    const projected = projectRoutineOccurrences({
      series: {
        id: definition.routine_id,
        state: document.state,
        generations: document.generations,
      },
      materialized: await this.getMaterialized(
        ownerId,
        definition.routine_id,
        window.start,
        window.end,
      ),
      window,
      planningTimeZone: zone,
    });
    if (!projected.ok) return null;
    const occurrence = projected.value.find(
      (row) =>
        row.id === key.occurrenceKey && row.state === 'planned' && row.timing.kind === 'timed',
    );
    if (occurrence === undefined || occurrence.timing.kind !== 'timed') return null;
    const dueAt = new Date(
      Date.parse(occurrence.timing.startsAt) + definition.offset_minutes * 60_000,
    ).toISOString() as Instant;
    if (dueAt !== receipt.due_at || dueAt < definition.remind_at_utc) return null;
    return {
      ...key,
      dueAt,
      title: document.title,
      href: `/plan/routines/${definition.routine_id}`,
    };
  }
  async listCentre(
    ownerId: OwnerId,
    before: NotificationKey | null,
    limit: number,
  ): Promise<readonly NotificationCentreItem[]> {
    type ReceiptRow = {
      reminder_id: UUID;
      reminder_revision: number;
      occurrence_key: string;
      due_at: Instant;
      observed_at: Instant;
      delivery_status: NotificationDeliveryStatus;
      read_at: Instant | null;
      dismissed_at: Instant | null;
    };
    const result: NotificationCentreItem[] = [];
    const wanted = Math.min(51, Math.max(1, limit));
    let cursor =
      before === null
        ? undefined
        : await this.driver.get<ReceiptRow>(
            `SELECT * FROM notification_receipts WHERE ${keyWhere};`,
            parametersFor(ownerId, before),
          );
    if (before !== null && cursor === undefined) return [];
    let quarantined = 0;
    while (result.length < wanted) {
      const rows = await this.driver.all<ReceiptRow>(
        `SELECT reminder_id, reminder_revision, occurrence_key, due_at, observed_at, delivery_status, read_at, dismissed_at
        FROM notification_receipts WHERE owner_id = ? AND dismissed_at IS NULL
        ${cursor === undefined ? '' : 'AND (observed_at, reminder_id, reminder_revision, occurrence_key) < (?, ?, ?, ?)'}
        ORDER BY observed_at DESC, reminder_id DESC, reminder_revision DESC, occurrence_key DESC LIMIT 51;`,
        [
          ownerId,
          ...(cursor === undefined
            ? []
            : [
                cursor.observed_at,
                cursor.reminder_id,
                cursor.reminder_revision,
                cursor.occurrence_key,
              ]),
        ],
      );
      for (const row of rows) {
        const validInstant = (value: unknown): boolean =>
          typeof value === 'string' && parseInstant(value).ok;
        const valid =
          typeof row.reminder_id === 'string' &&
          parseUUID(row.reminder_id).ok &&
          Number.isSafeInteger(row.reminder_revision) &&
          row.reminder_revision > 0 &&
          typeof row.occurrence_key === 'string' &&
          (row.occurrence_key === '' || parseUUID(row.occurrence_key).ok) &&
          ['centre', 'missed', 'attempting', 'delivered', 'failed'].includes(row.delivery_status) &&
          validInstant(row.due_at) &&
          validInstant(row.observed_at) &&
          (row.read_at === null || validInstant(row.read_at)) &&
          (row.dismissed_at === null || validInstant(row.dismissed_at));
        if (!valid) {
          quarantined += 1;
          continue;
        }
        const receipt: NotificationReceipt = {
          reminderId: row.reminder_id,
          reminderRevision: row.reminder_revision,
          occurrenceKey: row.occurrence_key,
          dueAt: row.due_at,
          observedAt: row.observed_at,
          deliveryStatus: row.delivery_status,
          readAt: row.read_at,
          dismissedAt: row.dismissed_at,
        };
        const target = await this.resolve(ownerId, receipt);
        result.push({
          ...receipt,
          title: target?.title ?? 'Reminder no longer available',
          href: target?.href ?? null,
        });
        if (result.length === wanted) break;
      }
      if (rows.length < 51) break;
      cursor = rows.at(-1);
    }
    // Read-time quarantine only: preserve the original receipt and its delivery claim.
    this.#quarantined.set(ownerId, quarantined);
    return result;
  }
}
