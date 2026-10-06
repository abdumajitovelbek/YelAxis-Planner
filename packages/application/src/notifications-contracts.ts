import type {
  CalendarDate,
  Clock,
  IanaTimeZone,
  Instant,
  MaterializedOccurrenceSnapshot,
  OwnerId,
  UUID,
} from '@yelaxis/domain';

import type { RoutineDocument } from './planning-contracts';
import type { SerialQueue } from './planning-kit';
import type { IdentityContextPort } from './ports';

export type NotificationPermissionStatus = 'unsupported' | 'default' | 'granted' | 'denied';
export type NotificationDeliveryStatus =
  'centre' | 'missed' | 'attempting' | 'delivered' | 'failed';
export interface NotificationPreferences {
  readonly alertsEnabled: boolean;
  readonly privacyMode: boolean;
}
export interface NotificationKey {
  readonly reminderId: UUID;
  readonly reminderRevision: number;
  /** Empty for a one-off reminder; deterministic occurrence UUID for a Routine. */
  readonly occurrenceKey: string;
}
export interface NotificationCandidate extends NotificationKey {
  readonly dueAt: Instant;
  readonly title: string;
  /** An internal application URL reconstructed from owned canonical rows. */
  readonly href: string;
}
export interface NotificationReceipt extends NotificationKey {
  readonly dueAt: Instant;
  readonly observedAt: Instant;
  readonly deliveryStatus: NotificationDeliveryStatus;
  readonly readAt: Instant | null;
  readonly dismissedAt: Instant | null;
}
export interface NotificationCentreItem extends NotificationReceipt {
  readonly title: string;
  readonly href: string | null;
}
export interface RoutineNotificationDefinition {
  readonly reminderId: UUID;
  readonly reminderRevision: number;
  readonly routineId: UUID;
  readonly document: RoutineDocument;
  readonly dueAt: Instant;
  readonly offsetMinutes: number;
  readonly nextDate: CalendarDate | null;
}
export interface NotificationTransaction {
  setPreferences(ownerId: OwnerId, value: NotificationPreferences, now: Instant): Promise<void>;
  claim(ownerId: OwnerId, receipt: NotificationReceipt): Promise<boolean>;
  setDeliveryStatus(
    ownerId: OwnerId,
    key: NotificationKey,
    status: NotificationDeliveryStatus,
  ): Promise<void>;
  markRead(ownerId: OwnerId, key: NotificationKey, now: Instant): Promise<void>;
  dismiss(ownerId: OwnerId, key: NotificationKey, now: Instant): Promise<void>;
  setRoutineCursor(
    ownerId: OwnerId,
    definition: RoutineNotificationDefinition,
    nextDate: CalendarDate,
  ): Promise<void>;
}
/** Owner-scoped, device-only operational state; canonical definitions are read-only here. */
export interface NotificationStorePort {
  transaction<T>(work: (transaction: NotificationTransaction) => Promise<T>): Promise<T>;
  getPreferences(ownerId: OwnerId): Promise<NotificationPreferences>;
  listDue(ownerId: OwnerId, now: Instant, limit: number): Promise<readonly NotificationCandidate[]>;
  listRoutines(
    ownerId: OwnerId,
    afterId: UUID | null,
    limit: number,
  ): Promise<readonly RoutineNotificationDefinition[]>;
  getPlanningZone(ownerId: OwnerId): Promise<IanaTimeZone>;
  getMaterialized(
    ownerId: OwnerId,
    routineId: UUID,
    start: CalendarDate,
    end: CalendarDate,
  ): Promise<readonly MaterializedOccurrenceSnapshot[]>;
  listCentre(
    ownerId: OwnerId,
    before: NotificationKey | null,
    limit: number,
  ): Promise<readonly NotificationCentreItem[]>;
  /** Device-only invalid receipts observed in the last owner-scoped read; originals retained. */
  getQuarantinedReceiptCount?(ownerId: OwnerId): number;
  /** Returns null for missing, archived, finished, canceled, or changed targets/definitions. */
  resolve(ownerId: OwnerId, key: NotificationKey): Promise<NotificationCandidate | null>;
}
export interface NotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
}
/** Implemented only by the browser adapter in the production composition root. */
export interface NotificationsPort {
  permission(): NotificationPermissionStatus;
  requestPermission(): Promise<NotificationPermissionStatus>;
  show(payload: NotificationPayload, onOpen: () => void): Promise<'delivered' | 'failed'>;
  closeAll(): void;
}
export interface NotificationView {
  readonly quarantinedReceiptCount?: number;
  readonly preferences: NotificationPreferences;
  readonly permission: NotificationPermissionStatus;
  readonly items: readonly NotificationCentreItem[];
  readonly nextPage: NotificationKey | null;
  readonly reconciliationError: string | null;
}
export interface NotificationApplication {
  getView(before?: NotificationKey | null): Promise<NotificationView>;
  setPreferences(input: unknown): Promise<void>;
  /** Must be invoked directly by a deliberate user gesture, never during reconciliation. */
  requestPermission(): Promise<NotificationPermissionStatus>;
  reconcile(): Promise<void>;
  markRead(key: NotificationKey): Promise<void>;
  dismiss(key: NotificationKey): Promise<void>;
  openTarget(key: NotificationKey): Promise<string | null>;
  stop(): void;
}
export interface NotificationApplicationDependencies {
  readonly store: NotificationStorePort;
  readonly notifications: NotificationsPort;
  readonly identity: IdentityContextPort;
  readonly clock: Clock;
  readonly queue: SerialQueue;
  readonly navigate: (href: string) => void;
}
