import {
  addDays,
  localDateOf,
  parseCalendarDate,
  parseUUID,
  projectRoutineOccurrences,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

import type {
  NotificationApplication,
  NotificationApplicationDependencies,
  NotificationCandidate,
  NotificationKey,
  NotificationPreferences,
  NotificationReceipt,
  RoutineNotificationDefinition,
} from './notifications-contracts';
import { routineSnapshot } from './planning-timed-items';

export const notificationPageSize = 50;
export const notificationGenericTitle = 'YelAxis Planner reminder';
export const notificationGenericBody = 'A reminder is due. Open YelAxis Planner to view it.';
const stopped = () => new Error('This notification session is closed. Reopen your plan.');

function validKey(key: NotificationKey): void {
  if (
    !parseUUID(key.reminderId).ok ||
    !Number.isSafeInteger(key.reminderRevision) ||
    key.reminderRevision < 1 ||
    (key.occurrenceKey !== '' && !parseUUID(key.occurrenceKey).ok)
  )
    throw new Error('This reminder is unavailable. Return to Notifications.');
}
function preferencesFrom(
  input: unknown,
  current: NotificationPreferences,
): NotificationPreferences {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('Choose valid notification settings.');
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !['alertsEnabled', 'privacyMode', 'confirmTitleExposure'].includes(key),
    ) ||
    typeof value['alertsEnabled'] !== 'boolean' ||
    typeof value['privacyMode'] !== 'boolean' ||
    (value['confirmTitleExposure'] !== undefined && value['confirmTitleExposure'] !== true)
  )
    throw new Error('Choose valid notification settings.');
  if (current.privacyMode && !value['privacyMode'] && value['confirmTitleExposure'] !== true)
    throw new Error(
      'Confirm the notification preview: planning titles can appear on a shared or locked screen.',
    );
  return { alertsEnabled: value['alertsEnabled'], privacyMode: value['privacyMode'] };
}

/**
 * Reconcile due canonical definitions into durable owner-scoped receipts. OS dispatch is at-most
 * once per device/revision/occurrence: persist the claim before calling the external adapter.
 * A crash between claim and dispatch leaves an internal reminder, never a duplicate OS attempt.
 * No command changes the Reminder definition or its target's lifecycle.
 */
export function createNotificationApplication(
  dependencies: NotificationApplicationDependencies,
): NotificationApplication {
  const { store, notifications, clock, queue } = dependencies;
  let closed = false;
  let sessionOwner: OwnerId | null = null;
  let routineAfter: UUID | null = null;
  let reconciliationError: string | null = null;
  async function owner(): Promise<OwnerId> {
    if (closed) throw stopped();
    const current = await dependencies.identity.getActiveIdentity();
    if (closed) throw stopped();
    if (current === null || (sessionOwner !== null && sessionOwner !== current.ownerId)) {
      closed = true;
      notifications.closeAll();
      throw stopped();
    }
    sessionOwner = current.ownerId;
    return current.ownerId;
  }
  async function claimCandidates(
    ownerId: OwnerId,
    candidates: readonly NotificationCandidate[],
    cursor?: {
      readonly definition: RoutineNotificationDefinition;
      readonly nextDate: ReturnType<typeof addDays>;
    },
  ): Promise<NotificationReceipt[]> {
    // Empty polls change no receipts or cursor. Avoid a full durable database transaction.
    if (candidates.length === 0 && cursor === undefined) return [];
    const now = clock.now();
    const preferences = await store.getPreferences(ownerId);
    const claimed = await store.transaction(async (transaction) => {
      const result: NotificationReceipt[] = [];
      for (const candidate of candidates) {
        const missed = Date.parse(now) - Date.parse(candidate.dueAt) > 60_000;
        const canDispatch =
          preferences.alertsEnabled && notifications.permission() === 'granted' && !missed;
        const receipt: NotificationReceipt = {
          ...candidate,
          observedAt: now,
          deliveryStatus: missed ? 'missed' : canDispatch ? 'attempting' : 'centre',
          readAt: null,
          dismissedAt: null,
        };
        if (await transaction.claim(ownerId, receipt)) result.push(receipt);
      }
      if (cursor !== undefined)
        await transaction.setRoutineCursor(ownerId, cursor.definition, cursor.nextDate);
      return result;
    });
    return claimed;
  }
  async function dispatchClaims(receipts: readonly NotificationReceipt[]): Promise<void> {
    const pending = receipts.filter((receipt) => receipt.deliveryStatus === 'attempting');
    let next = 0;
    // Browser dispatch waits outside the shared application queue. Four pending objects bound
    // adapter work while manual planning commands remain free to commit between database reads.
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (next < pending.length && !closed) {
          const receipt = pending[next++];
          if (receipt === undefined) continue;
          const prepared = await queue.run(async () => {
            const ownerId = await owner();
            const current = await store.resolve(ownerId, receipt);
            const choice = await store.getPreferences(ownerId);
            await owner();
            return current === null ||
              !choice.alertsEnabled ||
              notifications.permission() !== 'granted'
              ? null
              : { ownerId, current, choice };
          });
          if (prepared === null || closed) continue;
          const { ownerId, current, choice } = prepared;
          let status: 'delivered' | 'failed';
          try {
            status = await notifications.show(
              {
                title: notificationGenericTitle,
                body: choice.privacyMode ? notificationGenericBody : current.title,
                tag: `yelaxis:${ownerId}:${receipt.reminderId}:${String(receipt.reminderRevision)}:${receipt.occurrenceKey}`,
              },
              () => {
                if (closed) return;
                void application.openTarget(receipt).then(
                  (href) => {
                    if (!closed) dependencies.navigate(href ?? '/notifications');
                  },
                  () => {
                    /* A stopped or unavailable account cannot navigate. */
                  },
                );
              },
            );
          } catch {
            status = 'failed';
          }
          if (closed) {
            notifications.closeAll();
            return;
          }
          await queue.run(async () => {
            await owner();
            await store.transaction((transaction) =>
              transaction.setDeliveryStatus(ownerId, receipt, status),
            );
          });
        }
      }),
    );
  }
  async function reconcileRoutine(
    ownerId: OwnerId,
    definition: RoutineNotificationDefinition,
  ): Promise<NotificationReceipt[]> {
    const now = clock.now();
    const zone = await store.getPlanningZone(ownerId);
    const start = definition.nextDate ?? addDays(localDateOf(definition.dueAt, zone), -2);
    const latest = addDays(localDateOf(now, zone), 9); // Includes up to seven-day early reminders across zones.
    const end = addDays(start, 30) < latest ? addDays(start, 30) : latest;
    if (start > end) return [];
    const materialized = await store.getMaterialized(ownerId, definition.routineId, start, end);
    const projected = projectRoutineOccurrences({
      series: routineSnapshot({ id: definition.routineId, document: definition.document }),
      materialized,
      window: { start, end },
      planningTimeZone: zone,
    });
    if (!projected.ok)
      throw new Error('This routine reminder could not be read. Your plan was not changed.');
    const candidates: NotificationCandidate[] = [];
    let firstFutureDate: ReturnType<typeof addDays> | null = null;
    for (const occurrence of projected.value) {
      if (occurrence.state !== 'planned' || occurrence.timing.kind !== 'timed') continue;
      const dueAt = new Date(
        Date.parse(occurrence.timing.startsAt) + definition.offsetMinutes * 60_000,
      ).toISOString() as typeof now;
      if (dueAt < definition.dueAt) continue;
      if (dueAt > now) {
        const date =
          occurrence.period.kind === 'date' ? occurrence.period.date : occurrence.period.start;
        if (firstFutureDate === null || date < firstFutureDate) firstFutureDate = date;
        continue;
      }
      candidates.push({
        reminderId: definition.reminderId,
        reminderRevision: definition.reminderRevision,
        occurrenceKey: occurrence.id,
        dueAt,
        title: definition.document.title,
        href: `/plan/routines/${definition.routineId}`,
      });
    }
    // Future occurrences remain in the next window, so a poll cannot advance beyond them.
    const nextDate = firstFutureDate ?? addDays(end, 1);
    if (!parseCalendarDate(nextDate).ok)
      throw new Error('This routine reminder date is unavailable.');
    return claimCandidates(ownerId, candidates, { definition, nextDate });
  }
  const application: NotificationApplication = {
    getView: (before = null) =>
      queue.run(async () => {
        if (before !== null) validKey(before);
        const ownerId = await owner();
        const items = await store.listCentre(ownerId, before, notificationPageSize + 1);
        const visible = items.slice(0, notificationPageSize);
        return {
          preferences: await store.getPreferences(ownerId),
          permission: notifications.permission(),
          items: visible,
          nextPage: items.length > notificationPageSize ? (visible.at(-1) ?? null) : null,
          reconciliationError,
          quarantinedReceiptCount: store.getQuarantinedReceiptCount?.(ownerId) ?? 0,
        };
      }),
    setPreferences: (input) =>
      queue.run(async () => {
        const ownerId = await owner();
        const choice = preferencesFrom(input, await store.getPreferences(ownerId));
        if (choice.alertsEnabled && notifications.permission() !== 'granted')
          throw new Error(
            'Allow browser notification permission before enabling alerts. Internal reminders remain available.',
          );
        await store.transaction((transaction) =>
          transaction.setPreferences(ownerId, choice, clock.now()),
        );
        // Privacy changes also close old objects whose content reflects the prior choice.
        notifications.closeAll();
      }),
    requestPermission() {
      if (closed) return Promise.reject(stopped());
      // Preserve the browser gesture; do not put the permission request behind asynchronous reads.
      const request = notifications.requestPermission();
      return request.then((permission) =>
        queue.run(async () => {
          const ownerId = await owner();
          const previous = await store.getPreferences(ownerId);
          await store.transaction((transaction) =>
            transaction.setPreferences(
              ownerId,
              { ...previous, alertsEnabled: permission === 'granted' },
              clock.now(),
            ),
          );
          return permission;
        }),
      );
    },
    async reconcile() {
      try {
        const claimed = await queue.run(async () => {
          const ownerId = await owner();
          const receipts = await claimCandidates(
            ownerId,
            await store.listDue(ownerId, clock.now(), notificationPageSize),
          );
          const routines = await store.listRoutines(ownerId, routineAfter, notificationPageSize);
          for (const definition of routines) {
            await owner();
            receipts.push(...(await reconcileRoutine(ownerId, definition)));
          }
          routineAfter =
            routines.length === notificationPageSize ? (routines.at(-1)?.reminderId ?? null) : null;
          return receipts;
        });
        await dispatchClaims(claimed);
        reconciliationError = null;
      } catch {
        reconciliationError =
          'Due reminders could not be refreshed. Your reminder definitions remain saved. Retry when this plan is available.';
        if (closed) throw stopped();
        throw new Error(reconciliationError);
      }
    },
    markRead: (key) =>
      queue.run(async () => {
        validKey(key);
        const ownerId = await owner();
        await store.transaction((transaction) => transaction.markRead(ownerId, key, clock.now()));
      }),
    dismiss: (key) =>
      queue.run(async () => {
        validKey(key);
        const ownerId = await owner();
        await store.transaction((transaction) => transaction.dismiss(ownerId, key, clock.now()));
      }),
    openTarget: (key) =>
      queue.run(async () => {
        validKey(key);
        const ownerId = await owner();
        const target = await store.resolve(ownerId, key);
        if (target === null) return null;
        await owner();
        await store.transaction((transaction) => transaction.markRead(ownerId, key, clock.now()));
        return target.href;
      }),
    stop() {
      closed = true;
      notifications.closeAll();
    },
  };
  return application;
}
