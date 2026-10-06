import {
  createDayPeriod,
  createEntityRef,
  createInboxOrderKey,
  createMonthPeriod,
  createWeekPeriod,
  currentPlanningDate,
  entityRefKey,
  err,
  isActionOverdue,
  isCrossAxis,
  normalizeActionInput,
  ok,
  parseCalendarDate,
  parseUUID,
  resolveActionReminder,
  resolveFloatingDateTime,
  transitionLifecycle,
  validateAlignmentLink,
  validateTimeBlockInterval,
  type ActionReminderInput,
  type ActionState,
  type CalendarDate,
  type CaptureOrigin,
  type CommandId,
  type CommandContext,
  type DomainChange,
  type DomainError,
  type DomainEventDraft,
  type DomainResult,
  type EntityRef,
  type EntityRefKey,
  type EntityType,
  type HorizonPeriod,
  type Instant,
  type IanaTimeZone,
  type OwnerId,
  type ReminderSchedule,
  type UUID,
  type Weekday,
} from '@yelaxis/domain';

import { isActiveLink, linkDocument, linkRef } from './alignment-kit';
import {
  clearReviewItemTarget,
  reviewItemNames,
  reviewTargetClearedEventType,
} from './alignment-lifecycle';
import { applyEventTypes, createSerialQueue, type SerialQueue } from './planning-kit';
import type { ApplicationDependencies, PlanningRecordReader } from './ports';
import type {
  ApplicationResult,
  CanonicalMutation,
  CanonicalRecordState,
  CommandReceipt,
  ExpectedRevision,
  StoredUndoDescriptor,
} from './contracts';
import { executeCommand } from './execute-command';
import { actionInputContracts } from './earlier-command-input';
import { guardInputMethods } from './runtime-input';

export type ActionCanonicalDocument = Readonly<{
  title: string;
  captureOrigin: CaptureOrigin;
  note?: string;
  axisId?: UUID;
  projectId?: UUID;
  due?:
    | { readonly kind: 'date'; readonly date: CalendarDate }
    | {
        readonly kind: 'instant';
        readonly instant: Instant;
        readonly authoredTimeZone: IanaTimeZone;
      };
  estimateMinutes?: number;
  energy?: 'low' | 'medium' | 'high' | 'focused';
  priority?: 'low' | 'normal' | 'high';
  orderKey: string;
  state: ActionState;
  stateBeforeArchive?: Exclude<ActionState, 'archived'>;
  completedAt?: Instant;
  archivedAt?: Instant;
  convertedTo?: { readonly type: 'note' | 'project'; readonly id: UUID };
}>;

export type PlacementDocument = Readonly<{
  target:
    | { readonly kind: 'outcome'; readonly outcomeId: UUID }
    | { readonly kind: 'project'; readonly projectId: UUID }
    | { readonly kind: 'milestone'; readonly milestoneId: UUID }
    | { readonly kind: 'action'; readonly actionId: UUID };
  period: HorizonPeriod;
  orderKey: string;
  archivedAt?: Instant;
}>;

export type BlockDocument = Readonly<{
  target:
    | { readonly kind: 'action'; readonly actionId: UUID }
    | { readonly kind: 'routine_occurrence'; readonly routineOccurrenceId: UUID }
    | { readonly kind: 'commitment'; readonly commitmentId: UUID }
    | { readonly kind: 'custom'; readonly title: string };
  startsAt: Instant;
  endsAt: Instant;
  timeZone: IanaTimeZone;
  state: 'planned' | 'completed' | 'skipped' | 'canceled';
  supersededById?: UUID;
  overlapAcknowledged: boolean;
}>;

export type ReminderDocument = Readonly<{
  actionId: UUID;
  schedule: ReminderSchedule;
  state: 'scheduled' | 'delivered' | 'canceled';
}>;

export interface ActionWorkspace {
  readonly action: CanonicalRecordState;
  readonly createdAt: Instant;
  readonly placement: CanonicalRecordState | null;
  readonly plannedBlock: CanonicalRecordState | null;
  readonly reminder: CanonicalRecordState | null;
  readonly axisTitle?: string;
  readonly projectTitle?: string;
}

export interface ActionChoice {
  readonly id: UUID;
  readonly title: string;
  readonly localRevision: number;
  /**
   * Projects only: the Project's Axis, so a form can ask for the cross-Axis confirmation before
   * saving. Absent for Axes and for Projects without an Axis.
   */
  readonly axisId?: UUID;
}

/** An active Milestone offered by Inbox triage ("Plan" with an optional Milestone link). */
export interface MilestoneChoice {
  readonly id: UUID;
  readonly title: string;
  readonly localRevision: number;
  /** The parent Outcome, so Milestones with the same title can be told apart. */
  readonly outcomeId: UUID;
  readonly outcomeTitle: string;
}

export interface InboxActionItem {
  readonly id: UUID;
  readonly title: string;
  readonly state: 'inbox';
  readonly sortKey: string;
  readonly localRevision: number;
  readonly createdAt: Instant;
  readonly due?: ActionCanonicalDocument['due'];
  readonly estimateMinutes?: number;
  readonly energy?: ActionCanonicalDocument['energy'];
  readonly priority?: ActionCanonicalDocument['priority'];
}

export interface InboxPage {
  readonly items: readonly InboxActionItem[];
  readonly total: number;
  readonly nextCursor?: { readonly sortKey: string; readonly id: UUID };
}

export interface ProfilePlanningContext {
  readonly profileId: UUID;
  readonly planningTimeZone: IanaTimeZone;
  readonly weekStart: Weekday;
}

export interface ActionDeleteImpact {
  readonly placements: readonly CanonicalRecordState[];
  readonly reminders: readonly CanonicalRecordState[];
  readonly focusSelections: readonly CanonicalRecordState[];
  readonly timeBlocks: readonly CanonicalRecordState[];
  /** Active Milestone links. They block permanent delete until the person removes them. */
  readonly milestoneLinkCount: number;
  /**
   * The Action's unlinked (inactive) `milestone_action` records. They are history of the Action's
   * own links and are removed with it in the same transaction.
   */
  readonly inactiveMilestoneLinks: readonly CanonicalRecordState[];
  /**
   * Live review items naming the Action, in any state (active, archived, or in an archived review).
   * Permanent delete keeps every one and replaces only its target with `{ kind: 'deleted' }` in
   * the same transaction, so history shows "Deleted object". They never block.
   */
  readonly reviewItems: readonly CanonicalRecordState[];
  /**
   * Every review item row naming the Action. A row missing from `reviewItems` (one a sync
   * tombstone already removed) cannot be cleared, so the delete is refused without writing.
   */
  readonly reviewReferences: number;
}

export interface ActionPlanningQueryPort {
  getProfileContext(ownerId: OwnerId): Promise<ProfilePlanningContext>;
  getInboxEdge(ownerId: OwnerId, edge: 'first' | 'last'): Promise<string | null>;
  listInbox(
    ownerId: OwnerId,
    input: {
      readonly limit: number;
      readonly after?: { readonly sortKey: string; readonly id: UUID };
    },
  ): Promise<InboxPage>;
  listAllInbox(
    ownerId: OwnerId,
  ): Promise<readonly { readonly ref: EntityRef<'action'>; readonly revision: number }[]>;
  getActionWorkspace(ownerId: OwnerId, actionId: UUID): Promise<ActionWorkspace | null>;
  getActionDeleteImpact(ownerId: OwnerId, actionId: UUID): Promise<ActionDeleteImpact>;
  listAxes(ownerId: OwnerId): Promise<readonly ActionChoice[]>;
  listProjects(ownerId: OwnerId): Promise<readonly ActionChoice[]>;
  /** Milestones in state `active` (never archived) with their Outcome title, in a stable order. */
  listMilestones(ownerId: OwnerId): Promise<readonly MilestoneChoice[]>;
  /** The `milestone_action` link record of one pair in any state (active or unlinked), or null. */
  findMilestoneActionLink(
    ownerId: OwnerId,
    milestoneId: UUID,
    actionId: UUID,
  ): Promise<CanonicalRecordState | null>;
}

export interface CaptureIntent {
  readonly commandId: CommandId;
  readonly actionId: UUID;
  readonly origin: CaptureOrigin;
}

export interface ReminderForm {
  readonly enabled: boolean;
  readonly kind: 'at' | 'relative';
  readonly date?: string;
  readonly time?: string;
  readonly offsetMinutes?: number;
}

export interface ScheduleForm {
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
}

export interface ActionFormInput {
  readonly title: string;
  readonly note?: string;
  readonly axisId?: string;
  readonly projectId?: string;
  readonly plannedDate?: string;
  readonly dueDate?: string;
  readonly dueTime?: string;
  readonly estimateMinutes?: number;
  readonly energy?: string;
  readonly priority?: string;
  readonly schedule?: ScheduleForm;
  readonly reminder?: ReminderForm;
  /**
   * The person confirmed that this Action names a different Axis than its Project (placement
   * contract "Allowed relationships"). Asked only when the Axis or Project changes.
   */
  readonly confirmCrossAxis?: boolean;
}

export type TriageChoice =
  | { readonly kind: 'do'; readonly date?: string; readonly schedule?: ScheduleForm }
  | {
      readonly kind: 'plan';
      readonly period: { readonly kind: 'day' | 'week' | 'month'; readonly date: string };
      readonly projectId?: string;
      /** Also link the Action to this active Milestone; blank means none. */
      readonly milestoneId?: string;
      /** See `ActionFormInput.confirmCrossAxis`. */
      readonly confirmCrossAxis?: boolean;
    }
  | { readonly kind: 'keep_note' }
  | { readonly kind: 'keep_project' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'archive' }
  | { readonly kind: 'complete' };

export type BulkChange =
  | { readonly kind: 'do'; readonly date?: string }
  | {
      readonly kind: 'plan';
      readonly period: { readonly kind: 'day' | 'week' | 'month'; readonly date: string };
    }
  | { readonly kind: 'axis'; readonly axisId?: string; readonly confirmCrossAxis?: boolean }
  | { readonly kind: 'project'; readonly projectId?: string; readonly confirmCrossAxis?: boolean }
  | { readonly kind: 'complete' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'archive' };

export interface ActionApplication {
  newCaptureIntent(origin: CaptureOrigin): CaptureIntent;
  capture(
    intent: CaptureIntent,
    input: ActionFormInput,
  ): Promise<ApplicationResult<CommandReceipt>>;
  listInbox(input?: {
    readonly limit?: number;
    readonly after?: { readonly sortKey: string; readonly id: UUID };
  }): Promise<InboxPage>;
  listAllInbox(): Promise<
    readonly { readonly ref: EntityRef<'action'>; readonly revision: number }[]
  >;
  getAction(actionId: string): Promise<(ActionWorkspace & { readonly overdue: boolean }) | null>;
  listAxes(): Promise<readonly ActionChoice[]>;
  listProjects(): Promise<readonly ActionChoice[]>;
  /** Active Milestones for the Inbox "Plan" Milestone choice. */
  listMilestones(): Promise<readonly MilestoneChoice[]>;
  edit(
    actionId: string,
    revision: number,
    input: ActionFormInput,
    commandId?: CommandId,
  ): Promise<ApplicationResult<CommandReceipt>>;
  triage(
    actionId: string,
    revision: number,
    choice: TriageChoice,
    commandId?: CommandId,
  ): Promise<ApplicationResult<CommandReceipt>>;
  transition(
    actionId: string,
    revision: number,
    to: ActionState,
    commandId?: CommandId,
  ): Promise<ApplicationResult<CommandReceipt>>;
  reorder(
    actionId: string,
    revision: number,
    direction: 'up' | 'down',
    commandId?: CommandId,
  ): Promise<ApplicationResult<CommandReceipt>>;
  bulk(
    items: readonly { readonly id: UUID; readonly revision: number }[],
    change: BulkChange,
    commandId?: CommandId,
  ): Promise<ApplicationResult<CommandReceipt>>;
  undo(undoId: UUID, commandId?: CommandId): Promise<ApplicationResult<CommandReceipt>>;
  deletePermanently(
    actionId: string,
    revision: number,
    confirmation: string,
    commandId?: CommandId,
  ): Promise<ApplicationResult<CommandReceipt>>;
}

export function createActionApplication(
  dependencies: ApplicationDependencies,
  queries: ActionPlanningQueryPort,
  options: { readonly queue?: SerialQueue } = {},
): ActionApplication {
  const identity = async () => {
    const active = await dependencies.identityContext.getActiveIdentity();
    if (active === null) throw new Error('No active identity');
    return active;
  };
  const command = () => dependencies.ids.next();

  const application: ActionApplication = {
    newCaptureIntent(origin) {
      return { commandId: command(), actionId: dependencies.ids.next(), origin };
    },
    async capture(intent, input) {
      const active = await identity();
      const normalized = normalizeForm(input);
      if (!normalized.ok) return domainFailure(normalized);
      const relations = parseRelations(input);
      if (!relations.ok) return domainFailure(relations);
      if (!(await relationshipsAvailable(queries, active.ownerId, relations.value))) {
        return domainFailure(invalid('parent_unavailable'));
      }
      if (!captureOrigins.has(intent.origin)) return domainFailure(invalid('capture_origin'));
      const profile = await queries.getProfileContext(active.ownerId);
      const planned = buildPlanning(input, profile);
      if (!planned.ok) return domainFailure(planned);
      const edge = await queries.getInboxEdge(active.ownerId, 'first');
      const order = createInboxOrderKey(edge ?? undefined, 'before');
      if (!order.ok) return domainFailure(order);
      const actionRef = createEntityRef('action', intent.actionId, active.ownerId);
      return executeCommand(
        dependencies,
        {
          commandId: intent.commandId,
          ownerId: active.ownerId,
          actor: 'user',
          expectedRevisions: [],
          input: {
            actionRef,
            normalized: normalized.value,
            planned: planned.value,
            orderKey: order.value,
            origin: intent.origin,
          },
        },
        async ({ input: request, records, context }) => {
          const crossAxis = await confirmCrossAxisChange(
            records,
            context.ownerId,
            {},
            relations.value,
            input.confirmCrossAxis,
          );
          if (!crossAxis.ok) return crossAxis;
          const related = createRelatedForNewAction(
            request.actionRef,
            request.planned,
            context,
            dependencies,
          );
          const action: ActionCanonicalDocument = {
            ...request.normalized,
            ...relations.value,
            captureOrigin: request.origin,
            orderKey: request.orderKey,
            state:
              request.planned.block === undefined
                ? request.planned.placement === undefined
                  ? 'inbox'
                  : 'planned'
                : 'scheduled',
            ...(request.planned.due === undefined ? {} : { due: request.planned.due }),
          };
          const mutations: CanonicalMutation[] = [
            createMutation(request.actionRef, action),
            ...related.mutations,
          ];
          return ok(change(mutations, context, undefined, 'action.captured'));
        },
      );
    },
    async listInbox(input = {}) {
      const active = await identity();
      return queries.listInbox(active.ownerId, {
        limit: input.limit ?? 50,
        ...(input.after === undefined ? {} : { after: input.after }),
      });
    },
    async listAllInbox() {
      const active = await identity();
      return queries.listAllInbox(active.ownerId);
    },
    async getAction(value) {
      const parsed = parseUUID(value);
      if (!parsed.ok) return null;
      const active = await identity();
      const workspace = await queries.getActionWorkspace(active.ownerId, parsed.value);
      if (workspace === null) return null;
      const profile = await queries.getProfileContext(active.ownerId);
      const document = workspace.action.document as ActionCanonicalDocument;
      return {
        ...workspace,
        overdue: isActionOverdue(
          document.state,
          document.due,
          dependencies.clock,
          profile.planningTimeZone,
        ),
      };
    },
    async listAxes() {
      const active = await identity();
      return queries.listAxes(active.ownerId);
    },
    async listProjects() {
      const active = await identity();
      return queries.listProjects(active.ownerId);
    },
    async listMilestones() {
      const active = await identity();
      return queries.listMilestones(active.ownerId);
    },
    async edit(value, revision, input, requestedCommand) {
      const parsed = parseUUID(value);
      if (!parsed.ok) return domainFailure(parsed);
      const active = await identity();
      const workspace = await queries.getActionWorkspace(active.ownerId, parsed.value);
      if (workspace === null)
        return notFound(createEntityRef('action', parsed.value, active.ownerId));
      const normalized = normalizeForm(input);
      if (!normalized.ok) return domainFailure(normalized);
      const relations = parseRelations(input);
      if (!relations.ok) return domainFailure(relations);
      if (!(await relationshipsAvailable(queries, active.ownerId, relations.value)))
        return domainFailure(invalid('parent_unavailable'));
      const profile = await queries.getProfileContext(active.ownerId);
      const planned = buildPlanning(input, profile);
      if (!planned.ok) return domainFailure(planned);
      return runActionUpdate(
        dependencies,
        active.ownerId,
        workspace,
        revision,
        requestedCommand ?? command(),
        'action.edited',
        async ({ current, records, context }) => {
          if (
            planned.value.block !== undefined &&
            ['completed', 'canceled', 'archived'].includes(current.state)
          ) {
            return err({
              code: 'invalid_transition',
              message: 'Restore or reopen the Action before scheduling it.',
            });
          }
          const crossAxis = await confirmCrossAxisChange(
            records,
            context.ownerId,
            current,
            relations.value,
            input.confirmCrossAxis,
          );
          if (!crossAxis.ok) return crossAxis;
          const nextState: ActionState =
            planned.value.block !== undefined
              ? 'scheduled'
              : current.state === 'scheduled'
                ? 'planned'
                : current.state === 'inbox' && planned.value.placement !== undefined
                  ? 'planned'
                  : current.state;
          const lifecycle = {
            state: nextState,
            ...(current.stateBeforeArchive === undefined
              ? {}
              : { stateBeforeArchive: current.stateBeforeArchive }),
            ...(current.completedAt === undefined ? {} : { completedAt: current.completedAt }),
            ...(current.archivedAt === undefined ? {} : { archivedAt: current.archivedAt }),
            ...(current.convertedTo === undefined ? {} : { convertedTo: current.convertedTo }),
          };
          const next: ActionCanonicalDocument = {
            ...normalized.value,
            ...relations.value,
            captureOrigin: current.captureOrigin,
            orderKey: current.orderKey,
            ...lifecycle,
            ...(planned.value.due === undefined ? {} : { due: planned.value.due }),
          };
          return planActionAndRelated(
            next,
            workspace,
            planned.value,
            records,
            context,
            dependencies,
            true,
          );
        },
      );
    },
    async triage(value, revision, choice, requestedCommand) {
      const parsed = parseUUID(value);
      if (!parsed.ok) return domainFailure(parsed);
      const active = await identity();
      const workspace = await queries.getActionWorkspace(active.ownerId, parsed.value);
      if (workspace === null)
        return notFound(createEntityRef('action', parsed.value, active.ownerId));
      if ((workspace.action.document as ActionCanonicalDocument).state === 'archived') {
        return domainFailure(invalid('restore_before_triage'));
      }
      const profile = await queries.getProfileContext(active.ownerId);
      if (choice.kind === 'keep_note' || choice.kind === 'keep_project') {
        return runActionUpdate(
          dependencies,
          active.ownerId,
          workspace,
          revision,
          requestedCommand ?? command(),
          `action.${choice.kind}`,
          ({ current, context }) => {
            if (current.state === 'archived')
              return err({
                code: 'invalid_transition',
                message: 'Archived Actions must be restored first.',
              });
            const targetId = dependencies.ids.next();
            const targetType = choice.kind === 'keep_note' ? 'note' : 'project';
            const targetRef = createEntityRef(targetType, targetId, active.ownerId);
            const archived: ActionCanonicalDocument = {
              ...current,
              state: 'archived',
              stateBeforeArchive: current.state,
              archivedAt: context.now,
              convertedTo: { type: targetType, id: targetId },
            };
            const targetDocument =
              choice.kind === 'keep_note'
                ? {
                    title: current.title,
                    ...(current.note === undefined ? {} : { body: current.note }),
                    ...(current.axisId === undefined ? {} : { axisId: current.axisId }),
                    ...(current.projectId === undefined ? {} : { projectId: current.projectId }),
                    orderKey: current.orderKey,
                    state: 'active' as const,
                  }
                : {
                    title: current.title,
                    ...(current.note === undefined ? {} : { description: current.note }),
                    ...(current.axisId === undefined ? {} : { axisId: current.axisId }),
                    orderKey: current.orderKey,
                    state: 'idea' as const,
                  };
            return ok({
              mutations: [
                updateFrom(workspace.action, archived),
                createMutation(targetRef, targetDocument),
              ],
              createdInverse: [{ ref: targetRef, kind: targetType }],
            });
          },
        );
      }
      let planning: PlannedValues | undefined;
      let milestone: MilestoneLinkRequest | undefined;
      if (choice.kind === 'do') {
        const dateValue =
          choice.date ?? currentPlanningDate(dependencies.clock, profile.planningTimeZone);
        const planningResult = buildPlanning(
          {
            title: 'x',
            plannedDate: dateValue,
            ...(choice.schedule === undefined ? {} : { schedule: choice.schedule }),
          },
          profile,
        );
        if (!planningResult.ok) return domainFailure(planningResult);
        planning = planningResult.value;
      } else if (choice.kind === 'plan') {
        const periodResult = requestedPeriod(choice.period, profile.weekStart);
        if (!periodResult.ok) return domainFailure(periodResult);
        if (choice.projectId !== undefined) {
          const project = parseUUID(choice.projectId);
          if (!project.ok) return domainFailure(project);
          if (
            !(await relationshipsAvailable(queries, active.ownerId, { projectId: project.value }))
          )
            return domainFailure(invalid('parent_unavailable'));
        }
        if (choice.milestoneId !== undefined && choice.milestoneId !== '') {
          const milestoneId = parseUUID(choice.milestoneId);
          if (!milestoneId.ok) return domainFailure(milestoneId);
          const available = await queries.listMilestones(active.ownerId);
          if (!available.some(({ id }) => id === milestoneId.value))
            return domainFailure(milestoneUnavailable());
          milestone = {
            milestoneId: milestoneId.value,
            link: await queries.findMilestoneActionLink(
              active.ownerId,
              milestoneId.value,
              parsed.value,
            ),
          };
        }
        planning = {
          placement: periodResult.value,
          ...(choice.projectId === undefined ? {} : { projectId: choice.projectId }),
        };
      }
      const confirmCrossAxis = choice.kind === 'plan' ? choice.confirmCrossAxis : undefined;
      return runActionUpdate(
        dependencies,
        active.ownerId,
        workspace,
        revision,
        requestedCommand ?? command(),
        `action.${choice.kind}`,
        async ({ current, records, context }) => {
          if (planning !== undefined) {
            const project = parseOptionalId(planning.projectId);
            if (!project.ok) return project;
            const clean = without(
              without(without(current, 'stateBeforeArchive'), 'archivedAt'),
              'convertedTo',
            );
            const next: ActionCanonicalDocument = {
              ...clean,
              ...(project.value === undefined ? {} : { projectId: project.value }),
              state: planning.block === undefined ? 'planned' : 'scheduled',
            };
            const crossAxis = await confirmCrossAxisChange(
              records,
              context.ownerId,
              current,
              next,
              confirmCrossAxis,
            );
            if (!crossAxis.ok) return crossAxis;
            const planned = await planActionAndRelated(
              next,
              workspace,
              planning,
              records,
              context,
              dependencies,
              true,
            );
            if (!planned.ok || milestone === undefined) return planned;
            const linked = await planMilestoneLink(
              records,
              context.ownerId,
              workspace.action.ref as EntityRef<'action'>,
              next,
              milestone,
            );
            if (!linked.ok) return linked;
            return ok({
              mutations: [...planned.value.mutations, ...linked.value.mutations],
              createdInverse: [...planned.value.createdInverse, ...linked.value.createdInverse],
              eventDetails: linked.value.eventDetails,
            });
          }
          const to =
            choice.kind === 'cancel'
              ? 'canceled'
              : choice.kind === 'archive'
                ? 'archived'
                : 'completed';
          return transitionPlan(current, workspace, to, context);
        },
        milestone === undefined || milestone.link === null
          ? []
          : [{ ref: milestone.link.ref, revision: milestone.link.localRevision }],
      );
    },
    async transition(value, revision, to, requestedCommand) {
      const parsed = parseUUID(value);
      if (!parsed.ok) return domainFailure(parsed);
      const active = await identity();
      const workspace = await queries.getActionWorkspace(active.ownerId, parsed.value);
      if (workspace === null)
        return notFound(createEntityRef('action', parsed.value, active.ownerId));
      return runActionUpdate(
        dependencies,
        active.ownerId,
        workspace,
        revision,
        requestedCommand ?? command(),
        `action.${to}`,
        ({ current, context }) => transitionPlan(current, workspace, to, context),
      );
    },
    async reorder(value, revision, direction, requestedCommand) {
      const parsed = parseUUID(value);
      if (!parsed.ok) return domainFailure(parsed);
      const active = await identity();
      const all = await queries.listAllInbox(active.ownerId);
      const index = all.findIndex((item) => item.ref.id === parsed.value);
      const other = all[index + (direction === 'up' ? -1 : 1)];
      if (index < 0) return notFound(createEntityRef('action', parsed.value, active.ownerId));
      if (other === undefined) return domainFailure(invalid('order_edge'));
      const refs = [all[index]!, other];
      return executeCommand(
        dependencies,
        {
          commandId: requestedCommand ?? command(),
          ownerId: active.ownerId,
          actor: 'user',
          expectedRevisions: refs.map(({ ref, revision: itemRevision }) => ({
            ref,
            revision: itemRevision,
          })),
          input: { refs },
        },
        async ({ input: request, records, context }) => {
          const first = await records.read(request.refs[0]!.ref);
          const second = await records.read(request.refs[1]!.ref);
          if (first === null || second === null)
            return err({ code: 'invalid_value', message: 'The Inbox changed.' });
          const firstDoc = first.document as ActionCanonicalDocument;
          const secondDoc = second.document as ActionCanonicalDocument;
          if (
            firstDoc.state !== 'inbox' ||
            secondDoc.state !== 'inbox' ||
            first.localRevision !== revision
          )
            return err({ code: 'invalid_value', message: 'The Inbox changed.' });
          const mutations = [
            updateFrom(first, { ...firstDoc, orderKey: secondDoc.orderKey }),
            updateFrom(second, { ...secondDoc, orderKey: firstDoc.orderKey }),
          ];
          return ok(
            change(mutations, context, inverseForUpdates([first, second]), 'action.reordered'),
          );
        },
      );
    },
    async bulk(items, bulkChange, requestedCommand) {
      const active = await identity();
      if (items.length === 0 || new Set(items.map(({ id }) => id)).size !== items.length)
        return domainFailure(invalid('bulk_selection'));
      const refs = items.map(({ id, revision }) => ({
        ref: createEntityRef('action', id, active.ownerId),
        revision,
      }));
      const profile = await queries.getProfileContext(active.ownerId);
      if (bulkChange.kind === 'axis') {
        const axis = parseOptionalId(bulkChange.axisId);
        if (!axis.ok) return domainFailure(axis);
        if (
          !(await relationshipsAvailable(queries, active.ownerId, {
            ...(axis.value === undefined ? {} : { axisId: axis.value }),
          }))
        )
          return domainFailure(invalid('parent_unavailable'));
      }
      if (bulkChange.kind === 'project') {
        const project = parseOptionalId(bulkChange.projectId);
        if (!project.ok) return domainFailure(project);
        if (
          !(await relationshipsAvailable(queries, active.ownerId, {
            ...(project.value === undefined ? {} : { projectId: project.value }),
          }))
        )
          return domainFailure(invalid('parent_unavailable'));
      }
      let placementPeriod: HorizonPeriod | undefined;
      if (bulkChange.kind === 'do') {
        const parsedDate = parseCalendarDate(
          bulkChange.date ?? currentPlanningDate(dependencies.clock, profile.planningTimeZone),
        );
        if (!parsedDate.ok) return domainFailure(parsedDate);
        placementPeriod = createDayPeriod(parsedDate.value);
      } else if (bulkChange.kind === 'plan') {
        const result = requestedPeriod(bulkChange.period, profile.weekStart);
        if (!result.ok) return domainFailure(result);
        placementPeriod = result.value;
      }
      return executeCommand(
        dependencies,
        {
          commandId: requestedCommand ?? command(),
          ownerId: active.ownerId,
          actor: 'user',
          expectedRevisions: refs,
          input: { refs, bulkChange, placementPeriod },
        },
        async ({ input: request, records, context }) => {
          const actionMutations: CanonicalMutation[] = [];
          const relatedMutations: CanonicalMutation[] = [];
          const prior: CanonicalRecordState[] = [];
          const createdInverse: CreatedInverse[] = [];
          const projectAxes = new Map<UUID, string | undefined>();
          let crossAxisCount = 0;
          for (const expected of request.refs) {
            const record = await records.read(expected.ref);
            if (record === null)
              return err({ code: 'invalid_value', message: 'A selected Action no longer exists.' });
            const current = record.document as ActionCanonicalDocument;
            if (current.state !== 'inbox')
              return err({
                code: 'invalid_value',
                message: 'A selected Action is no longer in Inbox.',
              });
            prior.push(record);
            let next: ActionCanonicalDocument = current;
            if (request.placementPeriod !== undefined) {
              next = { ...next, state: 'planned' };
              const placementRef = createEntityRef(
                'planning_placement',
                dependencies.ids.next(),
                active.ownerId,
              );
              relatedMutations.push(
                createMutation(placementRef, {
                  target: { kind: 'action', actionId: expected.ref.id },
                  period: request.placementPeriod,
                  orderKey: current.orderKey,
                }),
              );
              createdInverse.push({ ref: placementRef, kind: 'planning_placement' });
            } else if (request.bulkChange.kind === 'axis') {
              const id = parseOptionalId(request.bulkChange.axisId);
              if (!id.ok) return id;
              next =
                id.value === undefined ? without(next, 'axisId') : { ...next, axisId: id.value };
            } else if (request.bulkChange.kind === 'project') {
              const id = parseOptionalId(request.bulkChange.projectId);
              if (!id.ok) return id;
              next =
                id.value === undefined
                  ? without(next, 'projectId')
                  : { ...next, projectId: id.value };
            } else {
              const to =
                request.bulkChange.kind === 'complete'
                  ? 'completed'
                  : request.bulkChange.kind === 'cancel'
                    ? 'canceled'
                    : 'archived';
              const transitioned = applyTransition(next, to, context.now);
              if (!transitioned.ok) return transitioned;
              next = transitioned.value;
            }
            if (request.bulkChange.kind === 'axis' || request.bulkChange.kind === 'project') {
              const pending = await crossAxisPending(
                records,
                context.ownerId,
                current,
                next,
                projectAxes,
              );
              if (!pending.ok) return pending;
              if (pending.value) crossAxisCount += 1;
            }
            actionMutations.push(updateFrom(record, next));
          }
          if (
            crossAxisCount > 0 &&
            (request.bulkChange.kind === 'axis' || request.bulkChange.kind === 'project') &&
            request.bulkChange.confirmCrossAxis !== true
          )
            return bulkCrossAxisRequired(request.bulkChange.kind, crossAxisCount);
          return ok(
            change(
              [...actionMutations, ...relatedMutations],
              context,
              inverseForUpdates(prior, createdInverse),
              `action.bulk_${request.bulkChange.kind}`,
            ),
          );
        },
      );
    },
    async undo(undoId, requestedCommand) {
      const active = await identity();
      return executeCommand(
        dependencies,
        {
          commandId: requestedCommand ?? command(),
          ownerId: active.ownerId,
          actor: 'user',
          expectedRevisions: [],
          consumesUndoId: undoId,
          input: {},
        },
        ({ undoDescriptor, records, context }) => planUndo(undoDescriptor, records, context),
      );
    },
    async deletePermanently(value, revision, confirmation, requestedCommand) {
      const parsed = parseUUID(value);
      if (!parsed.ok) return domainFailure(parsed);
      const active = await identity();
      const workspace = await queries.getActionWorkspace(active.ownerId, parsed.value);
      if (workspace === null) {
        const actionRef = createEntityRef('action', parsed.value, active.ownerId);
        // Already gone: a repeated command id still returns its receipt; otherwise not found.
        if (requestedCommand === undefined) return notFound(actionRef);
        return executeCommand(
          dependencies,
          {
            commandId: requestedCommand,
            ownerId: active.ownerId,
            actor: 'user',
            expectedRevisions: [{ ref: actionRef, revision }],
            input: {},
          },
          () => invalid('delete_target_missing'),
        );
      }
      const current = workspace.action.document as ActionCanonicalDocument;
      if (confirmation !== current.title) return domainFailure(invalid('delete_confirmation'));
      const impact = await queries.getActionDeleteImpact(active.ownerId, parsed.value);
      if (impact.milestoneLinkCount > 0)
        return domainFailure({
          ok: false,
          error: {
            code: 'delete_restricted',
            message: 'Remove Milestone links before permanently deleting this Action.',
          },
        });
      // A review item row this command cannot clear keeps the Action.
      if (impact.reviewReferences > impact.reviewItems.length)
        return domainFailure({
          ok: false,
          error: {
            code: 'delete_restricted',
            message:
              'Some history still refers to this Action. Archive it instead to keep that history.',
            details: { reason: 'delete_restricted', blockers: ['history_references'] },
          },
        });
      // Only this Action's own unlinked Milestone links are removed with it; never an active link.
      // Review decisions about it are kept with their reference cleared, never removed.
      if (
        !impact.inactiveMilestoneLinks.every((link) =>
          isUnlinkedMilestoneLinkOf(link, workspace.action.ref),
        ) ||
        !impact.reviewItems.every((item) => reviewItemNames(item, workspace.action.ref))
      )
        return domainFailure(
          invalid('delete_impact_changed', 'This Action changed. Review it and try again.'),
        );
      const expected: ExpectedRevision[] = [
        { ref: workspace.action.ref, revision },
        ...[
          ...impact.placements,
          ...impact.reminders,
          ...impact.focusSelections,
          ...impact.timeBlocks,
          ...impact.inactiveMilestoneLinks,
          ...impact.reviewItems,
        ].map((record) => ({ ref: record.ref, revision: record.localRevision })),
      ];
      return executeCommand(
        dependencies,
        {
          commandId: requestedCommand ?? command(),
          ownerId: active.ownerId,
          actor: 'user',
          expectedRevisions: expected,
          input: { workspace, impact },
        },
        ({ input: request, context }) => {
          const mutations: CanonicalMutation[] = [];
          for (const record of [
            ...request.impact.inactiveMilestoneLinks,
            ...request.impact.placements,
            ...request.impact.reminders,
            ...request.impact.focusSelections,
          ])
            mutations.push(deleteFrom(record, context.now));
          for (const block of request.impact.timeBlocks) {
            const document = block.document as BlockDocument;
            mutations.push(
              updateFrom(block, {
                ...document,
                target: { kind: 'custom', title: 'Deleted Action' },
                ...(document.state === 'planned' ? { state: 'canceled' as const } : {}),
              }),
            );
          }
          // Expected revisions keep each item as read; the decision stays, the reference goes.
          const keptReviews = new Set<string>();
          for (const item of request.impact.reviewItems) {
            const mutation = clearReviewItemTarget(item, request.workspace.action.ref, context.now);
            if (mutation === null)
              return invalid(
                'delete_impact_changed',
                'This Action changed. Review it and try again.',
              );
            mutations.push(mutation);
            keptReviews.add(entityRefKey(item.ref));
          }
          mutations.push(deleteFrom(request.workspace.action, context.now));
          return ok(
            applyEventTypes(
              change(mutations, context, undefined, 'action.permanently_deleted'),
              mutations,
              (mutation) =>
                keptReviews.has(entityRefKey(mutation.ref))
                  ? reviewTargetClearedEventType
                  : undefined,
            ),
          );
        },
      );
    },
  };
  return serializeActionApplication(
    guardInputMethods(application, actionInputContracts),
    options.queue ?? createSerialQueue(),
  );
}

/**
 * Browser SQLite intentionally rejects overlapping operations on its single worker connection.
 * Keep the Action use-case surface deterministic when UI reads and a user command arrive in the
 * same event-loop window. Individual commands retain their own transaction boundary. The composition
 * root passes the queue it also gives the planning facade, so the two never overlap.
 */
function serializeActionApplication(
  application: ActionApplication,
  queue: SerialQueue,
): ActionApplication {
  const run = <Result>(operation: () => Promise<Result>): Promise<Result> => queue.run(operation);
  return {
    newCaptureIntent: (origin) => application.newCaptureIntent(origin),
    capture: (intent, input) => run(() => application.capture(intent, input)),
    listInbox: (input) => run(() => application.listInbox(input)),
    listAllInbox: () => run(() => application.listAllInbox()),
    getAction: (actionId) => run(() => application.getAction(actionId)),
    listAxes: () => run(() => application.listAxes()),
    listProjects: () => run(() => application.listProjects()),
    listMilestones: () => run(() => application.listMilestones()),
    edit: (actionId, revision, input, commandId) =>
      run(() => application.edit(actionId, revision, input, commandId)),
    triage: (actionId, revision, choice, commandId) =>
      run(() => application.triage(actionId, revision, choice, commandId)),
    transition: (actionId, revision, to, commandId) =>
      run(() => application.transition(actionId, revision, to, commandId)),
    reorder: (actionId, revision, direction, commandId) =>
      run(() => application.reorder(actionId, revision, direction, commandId)),
    bulk: (items, change, commandId) => run(() => application.bulk(items, change, commandId)),
    undo: (undoId, commandId) => run(() => application.undo(undoId, commandId)),
    deletePermanently: (actionId, revision, confirmation, commandId) =>
      run(() => application.deletePermanently(actionId, revision, confirmation, commandId)),
  };
}

type PlannedValues = Readonly<{
  placement?: HorizonPeriod;
  block?: Omit<BlockDocument, 'target'>;
  due?: ActionCanonicalDocument['due'];
  reminder?: ReminderSchedule;
  projectId?: string;
}>;

function normalizeForm(input: ActionFormInput) {
  return normalizeActionInput({
    title: input.title,
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.estimateMinutes === undefined ? {} : { estimateMinutes: input.estimateMinutes }),
    ...(input.energy === undefined || input.energy === '' ? {} : { energy: input.energy }),
    ...(input.priority === undefined || input.priority === '' ? {} : { priority: input.priority }),
  });
}

function parseRelations(
  input: ActionFormInput,
): DomainResult<{ readonly axisId?: UUID; readonly projectId?: UUID }> {
  const axis = parseOptionalId(input.axisId);
  if (!axis.ok) return axis;
  const project = parseOptionalId(input.projectId);
  if (!project.ok) return project;
  return ok({
    ...(axis.value === undefined ? {} : { axisId: axis.value }),
    ...(project.value === undefined ? {} : { projectId: project.value }),
  });
}

async function relationshipsAvailable(
  queries: ActionPlanningQueryPort,
  ownerId: OwnerId,
  relationships: { readonly axisId?: UUID; readonly projectId?: UUID },
): Promise<boolean> {
  const axes = relationships.axisId === undefined ? [] : await queries.listAxes(ownerId);
  const projects = relationships.projectId === undefined ? [] : await queries.listProjects(ownerId);
  return (
    (relationships.axisId === undefined || axes.some(({ id }) => id === relationships.axisId)) &&
    (relationships.projectId === undefined ||
      projects.some(({ id }) => id === relationships.projectId))
  );
}

function buildPlanning(
  input: ActionFormInput,
  profile: ProfilePlanningContext,
): DomainResult<PlannedValues> {
  let placement: HorizonPeriod | undefined;
  if (input.plannedDate !== undefined && input.plannedDate !== '') {
    const parsed = parseCalendarDate(input.plannedDate);
    if (!parsed.ok) return parsed;
    placement = createDayPeriod(parsed.value);
  }
  let due: ActionCanonicalDocument['due'];
  if (input.dueDate !== undefined && input.dueDate !== '') {
    const parsed = parseCalendarDate(input.dueDate);
    if (!parsed.ok) return parsed;
    if (input.dueTime === undefined || input.dueTime === '')
      due = { kind: 'date', date: parsed.value };
    else {
      const instant = resolveFloatingDateTime({
        date: parsed.value,
        wallTime: input.dueTime as never,
        timeZone: profile.planningTimeZone,
        gapPolicy: 'shift_forward',
        overlapPolicy: 'earlier_offset',
      });
      if (!instant.ok || instant.value === null) return invalid('due_time');
      due = { kind: 'instant', instant: instant.value, authoredTimeZone: profile.planningTimeZone };
    }
  }
  let block: PlannedValues['block'];
  if (input.schedule !== undefined) {
    const dateValue = parseCalendarDate(input.schedule.date);
    if (!dateValue.ok) return dateValue;
    const start = resolveFloatingDateTime({
      date: dateValue.value,
      wallTime: input.schedule.startTime as never,
      timeZone: profile.planningTimeZone,
      gapPolicy: 'shift_forward',
      overlapPolicy: 'earlier_offset',
    });
    const end = resolveFloatingDateTime({
      date: dateValue.value,
      wallTime: input.schedule.endTime as never,
      timeZone: profile.planningTimeZone,
      gapPolicy: 'shift_forward',
      overlapPolicy: 'later_offset',
    });
    if (
      !start.ok ||
      !end.ok ||
      start.value === null ||
      end.value === null ||
      start.value >= end.value
    )
      return invalid('schedule');
    const interval = validateTimeBlockInterval(start.value, end.value, profile.planningTimeZone);
    if (!interval.ok) return interval;
    placement = createDayPeriod(dateValue.value);
    block = {
      startsAt: start.value,
      endsAt: end.value,
      timeZone: profile.planningTimeZone,
      state: 'planned',
      overlapAcknowledged: false,
    };
  }
  let reminder: ReminderSchedule | undefined;
  if (input.reminder?.enabled) {
    let reminderInput: ActionReminderInput;
    if (input.reminder.kind === 'at') {
      const reminderDate = parseCalendarDate(input.reminder.date ?? '');
      if (!reminderDate.ok || input.reminder.time === undefined) return invalid('reminder');
      reminderInput = {
        kind: 'at',
        date: reminderDate.value,
        wallTime: input.reminder.time,
        timeZone: profile.planningTimeZone,
        gapPolicy: 'shift_forward',
        overlapPolicy: 'earlier_offset',
      };
    } else {
      const anchor = due?.kind === 'instant' ? due.instant : block?.startsAt;
      if (anchor === undefined || input.reminder.offsetMinutes === undefined)
        return invalid('reminder_anchor');
      reminderInput = {
        kind: 'relative',
        anchor,
        offsetMinutes: input.reminder.offsetMinutes,
        timeZone: profile.planningTimeZone,
      };
    }
    const resolved = resolveActionReminder(reminderInput);
    if (!resolved.ok) return resolved;
    reminder = resolved.value;
  }
  return ok({
    ...(placement === undefined ? {} : { placement }),
    ...(block === undefined ? {} : { block }),
    ...(due === undefined ? {} : { due }),
    ...(reminder === undefined ? {} : { reminder }),
  });
}

function requestedPeriod(
  input: { readonly kind: 'day' | 'week' | 'month'; readonly date: string },
  weekStart: Weekday,
): DomainResult<HorizonPeriod> {
  const dateValue = parseCalendarDate(input.date);
  if (!dateValue.ok) return dateValue;
  return ok(
    input.kind === 'day'
      ? createDayPeriod(dateValue.value)
      : input.kind === 'week'
        ? createWeekPeriod(dateValue.value, weekStart)
        : createMonthPeriod(dateValue.value),
  );
}

type ActionRelations = Readonly<{ axisId?: UUID | undefined; projectId?: UUID | undefined }>;

/**
 * Whether an Action's new Axis/Project pair is cross-Axis and so needs the person's confirmation
 * (placement contract "Allowed relationships"): the Action names an Axis and its
 * Project names a different one. Only a new or changed pair asks, so an unchanged pair (confirmed
 * earlier, or a Project that moved to another Axis later) never blocks an unrelated edit. The
 * Project is read inside the command transaction; `projectAxes` caches reads within one command.
 */
async function crossAxisPending(
  records: PlanningRecordReader,
  ownerId: OwnerId,
  previous: ActionRelations,
  next: ActionRelations,
  projectAxes = new Map<UUID, string | undefined>(),
): Promise<DomainResult<boolean>> {
  const { axisId, projectId } = next;
  if (axisId === undefined || projectId === undefined) return ok(false);
  if (axisId === previous.axisId && projectId === previous.projectId) return ok(false);
  if (!projectAxes.has(projectId)) {
    const project = await records.read(createEntityRef('project', projectId, ownerId));
    if (project === null) return invalid('parent_unavailable');
    const projectAxis = project.document['axisId'];
    projectAxes.set(projectId, typeof projectAxis === 'string' ? projectAxis : undefined);
  }
  return ok(isCrossAxis(projectAxes.get(projectId), axisId));
}

async function confirmCrossAxisChange(
  records: PlanningRecordReader,
  ownerId: OwnerId,
  previous: ActionRelations,
  next: ActionRelations,
  confirmed: boolean | undefined,
): Promise<DomainResult<true>> {
  const pending = await crossAxisPending(records, ownerId, previous, next);
  if (!pending.ok) return pending;
  return pending.value && confirmed !== true ? crossAxisRequired() : ok(true);
}

function crossAxisRequired(): DomainResult<never> {
  return err({
    code: 'cross_axis_confirmation_required',
    message: 'This Action is in a different Axis than the Project. Confirm to link them.',
    details: { reason: 'cross_axis_confirmation_required', relationship: 'project_action' },
  });
}

function bulkCrossAxisRequired(kind: 'axis' | 'project', count: number): DomainResult<never> {
  const actions = count === 1 ? '1 selected Action' : `${String(count)} selected Actions`;
  const message =
    kind === 'project'
      ? `${actions} ${count === 1 ? 'is' : 'are'} in a different Axis than this Project. Confirm to link ${count === 1 ? 'it' : 'them'}.`
      : `${actions} ${count === 1 ? 'belongs' : 'belong'} to a Project in a different Axis. Confirm to change ${count === 1 ? 'its' : 'their'} Axis.`;
  return err({
    code: 'cross_axis_confirmation_required',
    message,
    details: { reason: 'cross_axis_confirmation_required', relationship: 'project_action', count },
  });
}

/** Minimized details of a relationship change in an audit event: a name and record ids only. */
type LinkEventDetails = Readonly<{ relationship: 'milestone_action'; nextId: UUID }>;

/** One planned Action change: its mutations, created records for undo, and event details. */
type ActionPlan = Readonly<{
  mutations: readonly CanonicalMutation[];
  createdInverse?: readonly CreatedInverse[];
  eventDetails?: ReadonlyMap<EntityRefKey, LinkEventDetails>;
}>;

interface MilestoneLinkRequest {
  readonly milestoneId: UUID;
  /** The pair's link record in any state when the command was prepared, or null. */
  readonly link: CanonicalRecordState | null;
}

/**
 * Link a planned Action to an active Milestone inside the triage transaction. An
 * active link stays as it is; an unlinked one is revived (same derived id, so no second row);
 * otherwise a new link is created. Neither endpoint changes state; undo unlinks again.
 */
async function planMilestoneLink(
  records: PlanningRecordReader,
  ownerId: OwnerId,
  action: EntityRef<'action'>,
  actionDocument: ActionCanonicalDocument,
  request: MilestoneLinkRequest,
): Promise<DomainResult<Required<ActionPlan>>> {
  const milestoneRef = createEntityRef('milestone', request.milestoneId, ownerId);
  const milestone = await records.read(milestoneRef);
  if (
    milestone === null ||
    milestone.document['state'] !== 'active' ||
    milestone.document['archivedAt'] !== undefined
  )
    return milestoneUnavailable();
  const existing = request.link === null ? null : await records.read(request.link.ref);
  if (
    request.link !== null &&
    (existing === null ||
      existing.document['milestoneId'] !== request.milestoneId ||
      existing.document['actionId'] !== action.id)
  )
    return err({
      code: 'invalid_value',
      message: 'This Milestone link changed. Review it and try again.',
      details: { reason: 'milestone_link_changed' },
    });
  const decision = validateAlignmentLink({
    relationship: 'milestone_action',
    parent: milestoneRef,
    child: action,
    parentArchived: false,
    childArchived: actionDocument.state === 'archived',
    activeLinkExists: existing !== null && isActiveLink(existing.document),
  });
  if (!decision.ok) return decision;
  if (decision.value.status === 'existing')
    return ok({ mutations: [], createdInverse: [], eventDetails: new Map() });
  const details: LinkEventDetails = {
    relationship: 'milestone_action',
    nextId: request.milestoneId,
  };
  if (existing === null) {
    const ref = linkRef(ownerId, 'milestone_action', request.milestoneId, action.id);
    return ok({
      mutations: [
        createMutation(ref, linkDocument('milestone_action', request.milestoneId, action.id)),
      ],
      createdInverse: [{ ref, kind: 'milestone_action' }],
      eventDetails: new Map([[entityRefKey(ref), details]]),
    });
  }
  return ok({
    mutations: [updateFrom(existing, without(existing.document, 'unlinkedAt'))],
    createdInverse: [],
    eventDetails: new Map([[entityRefKey(existing.ref), details]]),
  });
}

function milestoneUnavailable(): { readonly ok: false; readonly error: DomainError } {
  return {
    ok: false,
    error: {
      code: 'invalid_value',
      message: 'This Milestone is not available. Choose an active Milestone.',
      details: { reason: 'parent_unavailable', field: 'milestoneId' },
    },
  };
}

/** A `milestone_action` record of this Action (same owner) that is unlinked, never an active one. */
function isUnlinkedMilestoneLinkOf(link: CanonicalRecordState, action: EntityRef): boolean {
  return (
    link.ref.type === 'milestone_action' &&
    link.ref.ownerId === action.ownerId &&
    link.document['actionId'] === action.id &&
    !isActiveLink(link.document)
  );
}

async function runActionUpdate(
  dependencies: ApplicationDependencies,
  ownerId: OwnerId,
  workspace: ActionWorkspace,
  revision: number,
  commandId: CommandId,
  eventType: string,
  planner: (input: {
    readonly current: ActionCanonicalDocument;
    readonly records: PlanningRecordReader;
    readonly context: CommandContext;
  }) => DomainResult<ActionPlan> | Promise<DomainResult<ActionPlan>>,
  /** Other records the plan may update, at the revision read before the command (e.g. a link). */
  extraExpected: readonly ExpectedRevision[] = [],
) {
  const related = [workspace.placement, workspace.plannedBlock, workspace.reminder].filter(
    (record): record is CanonicalRecordState => record !== null,
  );
  return executeCommand(
    dependencies,
    {
      commandId,
      ownerId,
      actor: 'user',
      expectedRevisions: [
        { ref: workspace.action.ref, revision },
        ...related.map((record) => ({ ref: record.ref, revision: record.localRevision })),
        ...extraExpected,
      ],
      input: { workspace },
    },
    async ({ records, context }) => {
      const action = await records.read(workspace.action.ref);
      if (action === null)
        return err({ code: 'invalid_value', message: 'The Action no longer exists.' });
      const planned = await planner({
        current: action.document as ActionCanonicalDocument,
        records,
        context,
      });
      if (!planned.ok) return planned;
      const prior: CanonicalRecordState[] = [];
      for (const mutation of planned.value.mutations) {
        if (mutation.operation !== 'create') {
          const current = await records.read(mutation.ref);
          if (current === null)
            return err({ code: 'invalid_value', message: 'Related planning data changed.' });
          prior.push(current);
        }
      }
      return ok(
        change(
          planned.value.mutations,
          context,
          inverseForUpdates(prior, planned.value.createdInverse),
          eventType,
          planned.value.eventDetails,
        ),
      );
    },
  );
}

async function planActionAndRelated(
  next: ActionCanonicalDocument,
  workspace: ActionWorkspace,
  planned: PlannedValues,
  records: PlanningRecordReader,
  context: CommandContext,
  dependencies: ApplicationDependencies,
  manageReminder: boolean,
): Promise<DomainResult<{ mutations: CanonicalMutation[]; createdInverse: CreatedInverse[] }>> {
  const mutations: CanonicalMutation[] = [updateFrom(workspace.action, next)];
  const createdInverse: CreatedInverse[] = [];
  if (planned.placement !== undefined) {
    if (workspace.placement === null) {
      const ref = createEntityRef('planning_placement', dependencies.ids.next(), context.ownerId);
      mutations.push(
        createMutation(ref, {
          target: { kind: 'action', actionId: workspace.action.ref.id },
          period: planned.placement,
          orderKey: next.orderKey,
        }),
      );
      createdInverse.push({ ref, kind: 'planning_placement' });
    } else {
      const current = await records.read(workspace.placement.ref);
      if (current === null) return err({ code: 'invalid_value', message: 'Placement changed.' });
      mutations.push(
        updateFrom(current, {
          ...(current.document as PlacementDocument),
          period: planned.placement,
          archivedAt: undefined,
        }),
      );
    }
  } else if (workspace.placement !== null) {
    const current = await records.read(workspace.placement.ref);
    if (current !== null)
      mutations.push(
        updateFrom(current, {
          ...(current.document as PlacementDocument),
          archivedAt: context.now,
        }),
      );
  }
  if (planned.block !== undefined) {
    if (workspace.plannedBlock === null) {
      const ref = createEntityRef('time_block', dependencies.ids.next(), context.ownerId);
      mutations.push(
        createMutation(ref, {
          ...planned.block,
          target: { kind: 'action', actionId: workspace.action.ref.id },
        }),
      );
      createdInverse.push({ ref, kind: 'time_block' });
    } else {
      const current = await records.read(workspace.plannedBlock.ref);
      if (current === null) return err({ code: 'invalid_value', message: 'Schedule changed.' });
      mutations.push(
        updateFrom(current, {
          ...planned.block,
          target: { kind: 'action', actionId: workspace.action.ref.id },
        }),
      );
    }
  } else if (workspace.plannedBlock !== null) {
    const current = await records.read(workspace.plannedBlock.ref);
    if (current !== null)
      mutations.push(
        updateFrom(current, { ...(current.document as BlockDocument), state: 'canceled' }),
      );
  }
  if (manageReminder) {
    if (planned.reminder !== undefined) {
      if (workspace.reminder === null) {
        const ref = createEntityRef('reminder', dependencies.ids.next(), context.ownerId);
        mutations.push(
          createMutation(ref, {
            actionId: workspace.action.ref.id,
            schedule: planned.reminder,
            state: 'scheduled',
          }),
        );
        createdInverse.push({ ref, kind: 'reminder' });
      } else {
        const current = await records.read(workspace.reminder.ref);
        if (current === null) return err({ code: 'invalid_value', message: 'Reminder changed.' });
        mutations.push(
          updateFrom(current, {
            actionId: workspace.action.ref.id,
            schedule: planned.reminder,
            state: 'scheduled',
          }),
        );
      }
    } else if (workspace.reminder !== null) {
      const current = await records.read(workspace.reminder.ref);
      if (current !== null)
        mutations.push(
          updateFrom(current, { ...(current.document as ReminderDocument), state: 'canceled' }),
        );
    }
  }
  return ok({ mutations, createdInverse });
}

function transitionPlan(
  current: ActionCanonicalDocument,
  workspace: ActionWorkspace,
  to: ActionState,
  context: { readonly now: Instant },
): DomainResult<{ mutations: CanonicalMutation[] }> {
  const next = applyTransition(current, to, context.now);
  if (!next.ok) return next;
  return ok({ mutations: [updateFrom(workspace.action, next.value)] });
}
function applyTransition(
  current: ActionCanonicalDocument,
  to: ActionState,
  now: Instant,
): DomainResult<ActionCanonicalDocument> {
  const transitioned = transitionLifecycle({
    entityType: 'action',
    current: {
      state: current.state,
      ...(current.stateBeforeArchive === undefined
        ? {}
        : { stateBeforeArchive: current.stateBeforeArchive }),
    },
    to,
    ...(current.state === 'completed' && to === 'planned'
      ? { intent: 'reopen_or_undo' as const }
      : {}),
  });
  if (!transitioned.ok) return transitioned;
  const base = without(
    without(without(without(current, 'stateBeforeArchive'), 'archivedAt'), 'convertedTo'),
    'completedAt',
  );
  return ok({
    ...base,
    state: transitioned.value.state as ActionState,
    ...(transitioned.value.stateBeforeArchive === undefined
      ? {}
      : {
          stateBeforeArchive: transitioned.value.stateBeforeArchive as Exclude<
            ActionState,
            'archived'
          >,
        }),
    ...(to === 'archived' ? { archivedAt: now } : {}),
    ...(to === 'completed'
      ? { completedAt: now }
      : current.completedAt === undefined || to === 'planned'
        ? {}
        : { completedAt: current.completedAt }),
  });
}

type CreatedInverse = Readonly<{
  ref: EntityRef;
  kind: 'planning_placement' | 'time_block' | 'reminder' | 'note' | 'project' | 'milestone_action';
}>;
function inverseForUpdates(
  prior: readonly CanonicalRecordState[],
  createdInverse: readonly CreatedInverse[] = [],
) {
  return {
    prior: prior.map((record) => ({ ref: record.ref, document: record.document })),
    created: createdInverse,
  };
}

function change(
  mutations: readonly CanonicalMutation[],
  context: CommandContext,
  inverse: ReturnType<typeof inverseForUpdates> | undefined,
  eventType: string,
  eventDetails?: ReadonlyMap<EntityRefKey, LinkEventDetails>,
): DomainChange<readonly CanonicalMutation[]> {
  const touched = mutations.map(({ ref }) => ref);
  const events: DomainEventDraft[] = touched.map((aggregate) => ({
    aggregate,
    eventType,
    version: 1,
    actor: context.actor,
    commandId: context.commandId,
    occurredAt: context.now,
    payload: {
      operation:
        mutations.find((mutation) => entityRefKey(mutation.ref) === entityRefKey(aggregate))
          ?.operation ?? 'update',
      ...eventDetails?.get(entityRefKey(aggregate)),
    },
  }));
  return {
    value: mutations,
    touched,
    events,
    ...(inverse === undefined
      ? {}
      : {
          undo: {
            commandType: 'actions.restore_v1',
            version: 1 as const,
            payload: inverse,
            expectedRevisions: Object.fromEntries(
              mutations.map((mutation) => [
                entityRefKey(mutation.ref),
                mutation.operation === 'create' ? 1 : mutation.expectedRevision + 1,
              ]),
            ),
          },
        }),
  };
}

function createRelatedForNewAction(
  actionRef: EntityRef<'action'>,
  planned: PlannedValues,
  context: { readonly ownerId: OwnerId },
  dependencies: ApplicationDependencies,
) {
  const mutations: CanonicalMutation[] = [];
  if (planned.placement !== undefined)
    mutations.push(
      createMutation(
        createEntityRef('planning_placement', dependencies.ids.next(), context.ownerId),
        {
          target: { kind: 'action', actionId: actionRef.id },
          period: planned.placement,
          orderKey: '500000000000000',
        },
      ),
    );
  if (planned.block !== undefined)
    mutations.push(
      createMutation(createEntityRef('time_block', dependencies.ids.next(), context.ownerId), {
        ...planned.block,
        target: { kind: 'action', actionId: actionRef.id },
      }),
    );
  if (planned.reminder !== undefined)
    mutations.push(
      createMutation(createEntityRef('reminder', dependencies.ids.next(), context.ownerId), {
        actionId: actionRef.id,
        schedule: planned.reminder,
        state: 'scheduled',
      }),
    );
  return { mutations };
}

async function planUndo(
  descriptor: StoredUndoDescriptor | undefined,
  records: PlanningRecordReader,
  context: CommandContext,
): Promise<DomainResult<DomainChange<readonly CanonicalMutation[]>>> {
  if (descriptor === undefined || descriptor.descriptor.commandType !== 'actions.restore_v1')
    return err({ code: 'invalid_value', message: 'Undo is unavailable.' });
  const payload = parseRestorePayload(descriptor.descriptor.payload);
  if (payload === null) return err({ code: 'invalid_value', message: 'Undo data is invalid.' });
  const mutations: CanonicalMutation[] = [];
  for (const item of payload.prior) {
    const current = await records.read(item.ref);
    if (current === null)
      return err({ code: 'invalid_value', message: 'Undo target no longer exists.' });
    mutations.push(updateFrom(current, item.document));
  }
  for (const item of payload.created) {
    const current = await records.read(item.ref);
    if (current === null)
      return err({ code: 'invalid_value', message: 'Undo target no longer exists.' });
    const inverse = inverseOfCreated(item.kind, current.document, context.now);
    if (inverse !== null) mutations.push(updateFrom(current, inverse));
  }
  if (mutations.length === 0)
    return err({ code: 'invalid_value', message: 'There is nothing left to undo.' });
  return ok(change(mutations, context, undefined, 'action.undo_applied'));
}

/** Created records are archived or canceled; a created link becomes unlinked, never deleted. */
function inverseOfCreated(
  kind: CreatedInverse['kind'],
  document: Readonly<Record<string, unknown>>,
  now: Instant,
): Readonly<Record<string, unknown>> | null {
  switch (kind) {
    case 'planning_placement':
      return { ...document, archivedAt: now };
    case 'time_block':
    case 'reminder':
      return { ...document, state: 'canceled' };
    case 'milestone_action':
      return isActiveLink(document) ? { ...document, unlinkedAt: now } : null;
    case 'note':
    case 'project':
      return {
        ...document,
        state: 'archived',
        stateBeforeArchive: kind === 'project' ? 'idea' : 'active',
        archivedAt: now,
      };
  }
}

function createMutation(
  ref: EntityRef,
  document: Readonly<Record<string, unknown>>,
): CanonicalMutation {
  return {
    operation: 'create',
    ref,
    expectedRevision: null,
    baseServerRevision: 0,
    baseSnapshotHash: null,
    document,
  };
}
function updateFrom(
  record: CanonicalRecordState,
  document: Readonly<Record<string, unknown>>,
): CanonicalMutation {
  return {
    operation: 'update',
    ref: record.ref,
    expectedRevision: record.localRevision,
    baseServerRevision: record.serverRevision,
    baseSnapshotHash: record.baseSnapshotHash,
    document,
  };
}
function deleteFrom(record: CanonicalRecordState, now: Instant): CanonicalMutation {
  return {
    operation: 'delete',
    ref: record.ref,
    expectedRevision: record.localRevision,
    baseServerRevision: record.serverRevision,
    baseSnapshotHash: record.baseSnapshotHash,
    tombstone: {
      ownerId: record.ref.ownerId,
      entityType: record.ref.type,
      entityId: record.ref.id,
      revision: record.localRevision + 1,
      deletedAt: now,
    },
  };
}
function parseOptionalId(value: string | undefined): DomainResult<UUID | undefined> {
  if (value === undefined || value === '') return ok(undefined);
  return parseUUID(value);
}
function invalid(
  reason: string,
  message = 'The Action request is invalid.',
): {
  readonly ok: false;
  readonly error: DomainError;
} {
  return {
    ok: false,
    error: {
      code: 'invalid_value',
      message,
      details: { reason },
    },
  };
}
function domainFailure(result: {
  readonly ok: false;
  readonly error: DomainError;
}): ApplicationResult<never> {
  return { ok: false, error: { code: 'domain_rejected', domainError: result.error } };
}
function notFound(ref: EntityRef): ApplicationResult<never> {
  return { ok: false, error: { code: 'entity_not_found', ref } };
}
function without<T extends Readonly<Record<string, unknown>>, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const copy = { ...value };
  Reflect.deleteProperty(copy, key);
  return copy;
}

type RestorePrior = Readonly<{
  ref: EntityRef;
  document: Readonly<Record<string, unknown>>;
}>;

type RestorePayload = Readonly<{
  prior: readonly RestorePrior[];
  created: readonly CreatedInverse[];
}>;

const undoEntityTypes = new Set<string>([
  'profile',
  'axis',
  'outcome',
  'milestone',
  'project',
  'action',
  'note',
  'commitment',
  'time_block',
  'routine',
  'routine_occurrence',
  'routine_action_defaults',
  'template',
  'review',
  'review_item',
  'reminder',
  'context',
  'constraint',
  'planning_placement',
  'focus_selection',
  'theme',
  'direction',
  'milestone_action',
]);

function parseRestorePayload(payload: Readonly<Record<string, unknown>>): RestorePayload | null {
  const rawPrior = payload['prior'];
  const rawCreated = payload['created'];
  if (!Array.isArray(rawPrior) || !Array.isArray(rawCreated)) return null;

  const prior: RestorePrior[] = [];
  for (const rawItem of rawPrior) {
    const item: unknown = rawItem;
    if (!isUnknownRecord(item) || !isUnknownRecord(item['document'])) return null;
    const ref = parseUndoRef(item['ref']);
    if (ref === null) return null;
    prior.push({ ref, document: item['document'] });
  }

  const created: CreatedInverse[] = [];
  for (const rawItem of rawCreated) {
    const item: unknown = rawItem;
    if (!isUnknownRecord(item)) return null;
    const ref = parseUndoRef(item['ref']);
    const kind = parseCreatedKind(item['kind']);
    if (ref === null || kind === null || ref.type !== kind) return null;
    created.push({ ref, kind });
  }
  return { prior, created };
}

function parseUndoRef(value: unknown): EntityRef | null {
  if (!isUnknownRecord(value)) return null;
  const type = value['type'];
  const id = value['id'];
  const ownerId = value['ownerId'];
  if (
    typeof type !== 'string' ||
    !undoEntityTypes.has(type) ||
    typeof id !== 'string' ||
    typeof ownerId !== 'string'
  ) {
    return null;
  }
  const parsedId = parseUUID(id);
  const parsedOwner = parseUUID(ownerId);
  if (!parsedId.ok || !parsedOwner.ok) return null;
  return createEntityRef(type as EntityType, parsedId.value, parsedOwner.value);
}

function parseCreatedKind(value: unknown): CreatedInverse['kind'] | null {
  switch (value) {
    case 'planning_placement':
    case 'time_block':
    case 'reminder':
    case 'note':
    case 'project':
    case 'milestone_action':
      return value;
    default:
      return null;
  }
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const captureOrigins = new Set<CaptureOrigin>([
  'global_capture',
  'onboarding',
  'today',
  'plan',
  'axis',
  'review',
  'inbox',
  'project',
  'import',
  'other',
]);
