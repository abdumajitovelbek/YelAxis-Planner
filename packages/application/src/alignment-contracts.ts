/**
 * alignment application contracts: canonical join documents, read models for the
 * Axis, Outcome, Project, and Milestone pages and the alignment map, command inputs, the manual
 * alignment facade, and its owner-scoped query port.
 *
 * Every write is one `executeCommand` transaction with expected revisions, minimized audit events
 * (ids and relationship names only), a receipt, and a grouped `planning.restore_v1` undo (except
 * permanent delete). Nothing here ranks, scores, or changes a plan without an explicit command.
 */
import type {
  ActionState,
  AlignmentJoinRelationship,
  AlignmentKind,
  AlignmentNodeKind,
  AlignmentRelationship,
  AxisState,
  CalendarDate,
  CommandId,
  EntityRef,
  HorizonPeriod,
  Instant,
  MilestoneState,
  OutcomeState,
  OwnerId,
  PermanentDeleteBlocker,
  PermanentDeletePolicy,
  ProjectState,
  RestoreBlocker,
  UUID,
} from '@yelaxis/domain';

import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import type { AxisReviewNote } from './review-contracts';
import type { OutcomeProgressView } from './planning-contracts';

export type {
  AlignmentJoinRelationship,
  AlignmentKind,
  AlignmentNodeKind,
  AlignmentRelationship,
} from '@yelaxis/domain';

/* ───────────────────────── Canonical join documents ───────────────────────── */

/*
 * Each many-to-many link is one typed join record whose `unlinkedAt` mirrors the row's
 * `deleted_at`: absent means the link is active, set means it was unlinked (kept for history).
 * The id is `alignmentLinkId(relationship, parentId, childId)` from the domain (parent = Outcome or
 * Milestone, child = Project or Action), so relinking revives the same row and UNIQUE(owner, a, b)
 * always holds. Rows are physically removed only when an endpoint is permanently deleted.
 */

/** `project_secondary_outcome` (table `project_secondary_outcomes`): the Project also supports the Outcome. */
export type ProjectSecondaryOutcomeDocument = Readonly<{
  projectId: UUID;
  outcomeId: UUID;
  unlinkedAt?: Instant;
}>;

/** `milestone_project` (table `milestone_projects`): the Project supports the Milestone. */
export type MilestoneProjectDocument = Readonly<{
  milestoneId: UUID;
  projectId: UUID;
  unlinkedAt?: Instant;
}>;

/** `milestone_action` (table `milestone_actions`): the Action supports the Milestone. */
export type MilestoneActionDocument = Readonly<{
  milestoneId: UUID;
  actionId: UUID;
  unlinkedAt?: Instant;
}>;

export type AlignmentLinkDocument =
  ProjectSecondaryOutcomeDocument | MilestoneProjectDocument | MilestoneActionDocument;

/* ───────────────────────── Shared read-model pieces ───────────────────────── */

/** A record the command expects at `revision`. `id` is validated by the command (malformed → rejected). */
export interface RevisionRef<K extends AlignmentNodeKind = AlignmentKind> {
  readonly kind: K;
  readonly id: string;
  readonly revision: number;
}

/** A bounded list: at most the requested limit (hard cap 200) plus the full count. */
export interface Bounded<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/** Audit history shown on detail pages: event type and time only, never payloads or text. */
export interface HistoryEntry {
  readonly eventType: string;
  readonly occurredAt: Instant;
}

/** A related object as shown in a row. `archived` lets the UI say so in text, not color. */
export interface NodeRef {
  readonly id: UUID;
  readonly title: string;
  readonly state: string;
  readonly archived: boolean;
}

export interface AxisSummary {
  readonly id: UUID;
  readonly localRevision: number;
  readonly title: string;
  readonly purpose?: string;
  readonly color?: string;
  readonly icon?: string;
  readonly state: AxisState;
  readonly orderKey: string;
  readonly archivedAt?: Instant;
  /** Neutral counts of current members: Outcomes active or paused; Projects idea,
   * active, blocked, or paused; Routines active or paused. */
  readonly counts: {
    readonly outcomes: number;
    readonly projects: number;
    readonly routines: number;
  };
}

export interface OutcomeItem {
  readonly id: UUID;
  readonly localRevision: number;
  readonly title: string;
  readonly successDefinition: string;
  readonly state: OutcomeState;
  readonly stateBeforeArchive?: OutcomeState;
  readonly axis?: NodeRef;
  readonly targetStart?: CalendarDate;
  readonly targetEnd?: CalendarDate;
  readonly progress: OutcomeProgressView;
  /** Canceled Milestones, shown separately and never counted as progress. */
  readonly canceledMilestones: number;
  readonly placement?: { readonly id: UUID; readonly period: HorizonPeriod };
  readonly orderKey: string;
}

/** Next action of a Project: shown only for `active` Projects; a warning, never a block. */
export type NextActionView =
  | { readonly status: 'not_applicable' }
  | { readonly status: 'missing' }
  | {
      readonly status: 'present';
      readonly action: { readonly id: UUID; readonly title: string; readonly state: ActionState };
    };

export interface ProjectItem {
  readonly id: UUID;
  readonly localRevision: number;
  readonly title: string;
  readonly state: ProjectState;
  readonly stateBeforeArchive?: ProjectState;
  readonly desiredResult?: string;
  readonly axis?: NodeRef;
  readonly primaryOutcome?: NodeRef;
  readonly targetStart?: CalendarDate;
  readonly targetEnd?: CalendarDate;
  readonly placement?: { readonly id: UUID; readonly period: HorizonPeriod };
  readonly orderKey: string;
  readonly nextAction: NextActionView;
}

export interface MilestoneItem {
  readonly id: UUID;
  readonly localRevision: number;
  readonly title: string;
  readonly measurableCheckpoint: string;
  readonly state: MilestoneState;
  readonly stateBeforeArchive?: MilestoneState;
  /** The required parent. It always exists (RESTRICT foreign key) but may be archived. */
  readonly outcome: NodeRef;
  readonly targetStart?: CalendarDate;
  readonly targetEnd?: CalendarDate;
  readonly placement?: { readonly id: UUID; readonly period: HorizonPeriod };
  readonly orderKey: string;
}

/** A related object plus, for join links, the link record (used by Unlink). */
export interface LinkedItem<K extends AlignmentNodeKind> extends NodeRef {
  readonly kind: K;
  readonly localRevision: number;
  readonly linkId?: UUID;
  readonly linkRevision?: number;
}

/* ───────────────────────── Detail pages ───────────────────────── */

export interface AxisDetail {
  readonly axis: AxisSummary;
  readonly outcomes: Bounded<OutcomeItem>;
  readonly projects: Bounded<ProjectItem>;
  readonly routines: Bounded<LinkedItem<'routine'>>;
  /**
   * The most recent note written for this Axis in a completed review; null shows
   * "No review notes yet.".
   */
  readonly reviewNote: AxisReviewNote | null;
  readonly history: readonly HistoryEntry[];
}

export interface OutcomeDetail {
  readonly outcome: OutcomeItem;
  readonly milestones: Bounded<MilestoneItem>;
  readonly primaryProjects: Bounded<ProjectItem>;
  readonly supportingProjects: Bounded<LinkedItem<'project'>>;
  readonly history: readonly HistoryEntry[];
}

export interface ProjectDetail {
  /** `notes` is the Project's own notes field; Note records are listed as `capturedNotes`. */
  readonly project: ProjectItem & { readonly description?: string; readonly notes?: string };
  readonly secondaryOutcomes: readonly LinkedItem<'outcome'>[];
  readonly milestones: Bounded<LinkedItem<'milestone'>>;
  readonly actions: Bounded<LinkedItem<'action'> & { readonly orderKey: string }>;
  readonly capturedNotes: Bounded<LinkedItem<'note'>>;
  readonly history: readonly HistoryEntry[];
}

export interface MilestoneDetail {
  readonly milestone: MilestoneItem;
  /** The Axis of the parent Outcome, when it has one. */
  readonly axis?: NodeRef;
  readonly projects: Bounded<LinkedItem<'project'>>;
  readonly actions: Bounded<LinkedItem<'action'>>;
  readonly history: readonly HistoryEntry[];
}

/** Outcomes and Projects that are in no Axis ("Not in an Axis"). */
export interface UnassignedView {
  readonly outcomes: Bounded<OutcomeItem>;
  readonly projects: Bounded<ProjectItem>;
}

/* ───────────────────────── Alignment map and relationship list ───────────────────────── */

export interface AlignmentNode extends NodeRef {
  readonly kind: AlignmentNodeKind;
  readonly localRevision: number;
}

/** One direct relationship of the focus. `up` edges lead to parents, `down` edges to children. */
export interface AlignmentEdge {
  readonly relationship: AlignmentRelationship;
  readonly direction: 'up' | 'down';
  /** Required edges (a Milestone's Outcome) offer Move to another Outcome, never Unlink. */
  readonly required: boolean;
  /** Join relationships only: the link record, for Unlink. */
  readonly linkId?: UUID;
  readonly linkRevision?: number;
  readonly other: AlignmentNode;
}

export interface AlignmentNeighborhood {
  readonly focus: AlignmentNode & {
    readonly progress?: OutcomeProgressView;
    readonly targetStart?: CalendarDate;
    readonly targetEnd?: CalendarDate;
  };
  /** Ancestry to the Axis along required and primary links, Axis first. */
  readonly chain: readonly AlignmentNode[];
  /** Direct parents in the catalog's fixed order. Archived endpoints stay listed (flagged). */
  readonly above: readonly AlignmentEdge[];
  /** Direct children, depth 1, at most `limit` per relationship. Archived endpoints are flagged. */
  readonly below: readonly AlignmentEdge[];
  /** Full counts per relationship, for "Show all N". */
  readonly totals: Readonly<Partial<Record<AlignmentRelationship, number>>>;
}

/* ───────────────────────── Command inputs ───────────────────────── */

/**
 * Link one pair. Single-valued kinds (Axis membership, primary Outcome, an Action's Project) carry
 * the child's revision because its foreign key changes; replacing an existing parent needs
 * `replaceExisting` after the preview. Join kinds create or revive the derived-id link record.
 */
export type LinkInput =
  | {
      readonly relationship: 'axis_outcome';
      readonly axisId: string;
      readonly outcome: RevisionRef<'outcome'>;
      readonly replaceExisting?: boolean;
    }
  | {
      readonly relationship: 'axis_project';
      readonly axisId: string;
      readonly project: RevisionRef<'project'>;
      readonly replaceExisting?: boolean;
    }
  | {
      readonly relationship: 'outcome_primary_project';
      readonly outcomeId: string;
      readonly project: RevisionRef<'project'>;
      readonly replaceExisting?: boolean;
    }
  | {
      readonly relationship: 'outcome_secondary_project';
      readonly outcomeId: string;
      readonly projectId: string;
    }
  | {
      readonly relationship: 'milestone_project';
      readonly milestoneId: string;
      readonly projectId: string;
    }
  | {
      readonly relationship: 'milestone_action';
      readonly milestoneId: string;
      readonly actionId: string;
    }
  | {
      readonly relationship: 'project_action';
      readonly projectId: string;
      readonly action: RevisionRef<'action'>;
      readonly replaceExisting?: boolean;
      readonly confirmCrossAxis?: boolean;
    };

/** Unlink one pair. A Milestone's Outcome cannot be unlinked; it is reparented instead. */
export type UnlinkInput =
  | { readonly relationship: 'axis_outcome'; readonly outcome: RevisionRef<'outcome'> }
  | { readonly relationship: 'axis_project'; readonly project: RevisionRef<'project'> }
  | { readonly relationship: 'outcome_primary_project'; readonly project: RevisionRef<'project'> }
  | { readonly relationship: 'project_action'; readonly action: RevisionRef<'action'> }
  | {
      readonly relationship: AlignmentJoinRelationship;
      readonly linkId: string;
      readonly revision: number;
    };

export interface LinkPreview {
  readonly allowed: boolean;
  readonly alreadyLinked: boolean;
  readonly reason?:
    | 'archived_endpoint'
    | 'cardinality_violation'
    | 'primary_is_secondary'
    | 'unsupported_relationship'
    | 'not_found';
  /** The current parent a single-valued link would replace ("Replaces current primary Outcome …"). */
  readonly replaces?: AlignmentNode;
  /** `project_action` across different Axes: the dialog requires an explicit confirmation. */
  readonly crossAxis: boolean;
}

/** An active duplicate link: nothing is written and no undo is offered. */
export interface NoChangeReceipt {
  readonly status: 'no_change';
  readonly reason: 'already_linked';
}

export type AlignmentResult = Promise<ApplicationResult<CommandReceipt>>;

export interface AxisInput {
  readonly title: string;
  readonly purpose?: string;
  /** One of the domain `axisColorTokens`. */
  readonly color?: string;
  readonly icon?: string;
}

export type OutcomeProgressInput =
  | { readonly mode: 'none' }
  | { readonly mode: 'manual'; readonly percentage: number }
  | { readonly mode: 'milestone_derived' };

export interface OutcomeInput {
  readonly title: string;
  readonly successDefinition: string;
  readonly axisId?: string;
  readonly targetStart?: string;
  readonly targetEnd?: string;
  readonly progress?: OutcomeProgressInput;
}

export interface ProjectInput {
  readonly title: string;
  readonly desiredResult?: string;
  readonly description?: string;
  readonly notes?: string;
  readonly axisId?: string;
  readonly primaryOutcomeId?: string;
  readonly targetStart?: string;
  readonly targetEnd?: string;
  /** `active` needs a desired result. */
  readonly state?: 'idea' | 'active';
}

export interface MilestoneInput {
  readonly outcomeId: string;
  readonly title: string;
  readonly measurableCheckpoint: string;
  readonly targetStart?: string;
  readonly targetEnd?: string;
}

/** Ordering containers. `axisId: null` is "Not in an Axis". */
export type ReorderScope =
  | { readonly container: 'axes' }
  | { readonly container: 'axis_outcomes'; readonly axisId: string | null }
  | { readonly container: 'axis_projects'; readonly axisId: string | null }
  | { readonly container: 'outcome_milestones'; readonly outcomeId: string }
  | { readonly container: 'project_actions'; readonly projectId: string };

/* ───────────────────────── Archive, restore, and delete previews ───────────────────────── */

export interface ArchiveImpactView {
  readonly target: AlignmentNode;
  /** Non-archived direct children that stay active and show an "archived parent" indicator. */
  readonly activeChildren: Readonly<Partial<Record<AlignmentNodeKind, number>>>;
  /** Archive keeps the target's placement (it reappears on restore). */
  readonly placementKept: boolean;
  /** Reminders cannot target Axes, Outcomes, Projects, or Milestones, so none are disabled. */
  readonly remindersToDisable: 0;
}

/** Relationships a permanent delete can clear: the alignment catalog plus Axis membership of Actions and Notes. */
export type DeleteReferrerRelationship = AlignmentRelationship | 'axis_action' | 'axis_note';

export interface ImpactItem {
  readonly kind: AlignmentNodeKind | 'placement' | 'selection';
  readonly id: UUID;
  readonly title?: string;
  readonly relationship?: DeleteReferrerRelationship;
  readonly archived: boolean;
}

export interface DeleteImpactView {
  readonly target: AlignmentNode;
  readonly policy: PermanentDeletePolicy;
  readonly allowed: boolean;
  readonly blockers: readonly PermanentDeleteBlocker[];
  /** An Outcome's Milestones (any state): move or delete each one first. */
  readonly requiredChildren: Bounded<ImpactItem>;
  /** Links that `unlink_and_delete` removes; no other object is ever deleted. */
  readonly optionalLinks: Bounded<ImpactItem>;
  readonly placements: number;
  readonly selections: number;
  /**
   * `reviews` is informational: the review decisions about the target that review history lists
   * (not a removed choice, not in an archived review), which stay as "Deleted object" and never
   * block. Every kept item, listed or not, loses only its reference (placement
   * contract, permanent delete rule 6). `routineDefaults` still block deletion under every policy
   */
  readonly historyReferences: { readonly reviews: number; readonly routineDefaults: number };
  /** The target's own history rows, always removed with it and disclosed. */
  readonly removedHistory: {
    readonly inactiveLinks: number;
    readonly archivedPlacements: number;
    readonly archivedSelections: number;
  };
  readonly pendingSync: boolean;
  readonly openConflict: boolean;
  /** The exact current title the person types to confirm. */
  readonly confirmationText: string;
}

/* ───────────────────────── Facade ───────────────────────── */

/**
 * Manual alignment facade. Every method is serialized on the shared browser queue, so a
 * pre-transaction read and its command never interleave with another call.
 *
 * Commands return `domain_rejected` with a calm, actionable `DomainError` message, or
 * `entity_not_found`, `revision_conflict`, or `transaction_failed` (nothing was changed). Created
 * ids are in `receipt.canonical[0].ref.id`. Undo uses the shared `planning.undo`.
 */
export interface AlignmentApplication {
  /* Queries: read-only; a malformed or unknown id returns null. */
  listAxes(options?: { readonly includeArchived?: boolean }): Promise<Bounded<AxisSummary>>;
  listUnassigned(): Promise<UnassignedView>;
  getAxis(
    axisId: string,
    options?: { readonly includeFinished?: boolean },
  ): Promise<AxisDetail | null>;
  getOutcome(outcomeId: string): Promise<OutcomeDetail | null>;
  getProject(
    projectId: string,
    options?: { readonly actionLimit?: number },
  ): Promise<ProjectDetail | null>;
  getMilestone(milestoneId: string): Promise<MilestoneDetail | null>;
  getNeighborhood(
    focus: { readonly kind: AlignmentNodeKind; readonly id: string },
    options?: { readonly limit?: number },
  ): Promise<AlignmentNeighborhood | null>;
  listLinkCandidates(input: {
    readonly focus: { readonly kind: AlignmentNodeKind; readonly id: string };
    readonly relationship: AlignmentRelationship;
    readonly search?: string;
    readonly limit?: number;
  }): Promise<
    Bounded<AlignmentNode & { readonly alreadyLinked: boolean; readonly crossAxis: boolean }>
  >;
  /** Every non-archived object of the kind, for form pickers. */
  listChoices(kind: AlignmentKind): Promise<readonly AlignmentNode[]>;
  previewLink(input: LinkInput): Promise<LinkPreview>;
  previewArchive(target: {
    readonly kind: AlignmentKind;
    readonly id: string;
  }): Promise<ArchiveImpactView | null>;
  previewRestore(target: { readonly kind: AlignmentKind; readonly id: string }): Promise<{
    readonly allowed: boolean;
    readonly blockers: readonly RestoreBlocker[];
    readonly restoresTo: string;
  } | null>;
  previewDelete(
    target: { readonly kind: AlignmentKind; readonly id: string },
    policy: PermanentDeletePolicy,
  ): Promise<DeleteImpactView | null>;

  /* Commands: one executeCommand each; grouped planning.restore_v1 undo except permanent delete. */
  createAxis(input: AxisInput, commandId?: CommandId): AlignmentResult;
  editAxis(ref: RevisionRef<'axis'>, input: AxisInput, commandId?: CommandId): AlignmentResult;
  createOutcome(input: OutcomeInput, commandId?: CommandId): AlignmentResult;
  editOutcome(
    ref: RevisionRef<'outcome'>,
    input: Omit<OutcomeInput, 'axisId' | 'progress'>,
    commandId?: CommandId,
  ): AlignmentResult;
  setOutcomeProgress(
    ref: RevisionRef<'outcome'>,
    progress: OutcomeProgressInput,
    commandId?: CommandId,
  ): AlignmentResult;
  transitionOutcome(
    ref: RevisionRef<'outcome'>,
    to: Exclude<OutcomeState, 'archived'>,
    commandId?: CommandId,
  ): AlignmentResult;
  createProject(input: ProjectInput, commandId?: CommandId): AlignmentResult;
  editProject(
    ref: RevisionRef<'project'>,
    input: Omit<ProjectInput, 'axisId' | 'primaryOutcomeId' | 'state'>,
    commandId?: CommandId,
  ): AlignmentResult;
  transitionProject(
    ref: RevisionRef<'project'>,
    to: Exclude<ProjectState, 'archived' | 'idea'>,
    commandId?: CommandId,
  ): AlignmentResult;
  createMilestone(input: MilestoneInput, commandId?: CommandId): AlignmentResult;
  editMilestone(
    ref: RevisionRef<'milestone'>,
    input: Omit<MilestoneInput, 'outcomeId'>,
    commandId?: CommandId,
  ): AlignmentResult;
  transitionMilestone(
    ref: RevisionRef<'milestone'>,
    to: Exclude<MilestoneState, 'archived'>,
    commandId?: CommandId,
  ): AlignmentResult;
  reparentMilestone(
    ref: RevisionRef<'milestone'>,
    outcomeId: string,
    commandId?: CommandId,
  ): AlignmentResult;
  reorder(
    input: {
      readonly target: RevisionRef<AlignmentKind | 'action'>;
      readonly direction: 'up' | 'down';
      readonly scope: ReorderScope;
    },
    commandId?: CommandId,
  ): AlignmentResult;
  link(
    input: LinkInput,
    commandId?: CommandId,
  ): Promise<ApplicationResult<CommandReceipt | NoChangeReceipt>>;
  unlink(input: UnlinkInput, commandId?: CommandId): AlignmentResult;
  archive(target: RevisionRef, commandId?: CommandId): AlignmentResult;
  restore(target: RevisionRef, commandId?: CommandId): AlignmentResult;
  /** Not undoable. `confirmation` must equal the current title exactly. */
  deletePermanently(
    input: {
      readonly target: RevisionRef;
      readonly policy: PermanentDeletePolicy;
      readonly confirmation: string;
    },
    commandId?: CommandId,
  ): AlignmentResult;
}

/* Method sets of the four implementation modules composed by `createAlignmentApplication`. */

/** Read-only projections (part A1): `alignment-projections.ts`. */
export type AlignmentProjectionMethods = Pick<
  AlignmentApplication,
  | 'listAxes'
  | 'listUnassigned'
  | 'getAxis'
  | 'getOutcome'
  | 'getProject'
  | 'getMilestone'
  | 'getNeighborhood'
  | 'listLinkCandidates'
  | 'listChoices'
>;

/** Object commands (part A2): `alignment-objects.ts`. */
export type AlignmentObjectMethods = Pick<
  AlignmentApplication,
  | 'createAxis'
  | 'editAxis'
  | 'createOutcome'
  | 'editOutcome'
  | 'setOutcomeProgress'
  | 'transitionOutcome'
  | 'createProject'
  | 'editProject'
  | 'transitionProject'
  | 'createMilestone'
  | 'editMilestone'
  | 'transitionMilestone'
  | 'reorder'
>;

/** Link commands (part A3): `alignment-links.ts`. */
export type AlignmentLinkMethods = Pick<
  AlignmentApplication,
  'previewLink' | 'link' | 'unlink' | 'reparentMilestone'
>;

/** Archive, restore, and permanent delete (part A3): `alignment-lifecycle.ts`. */
export type AlignmentLifecycleMethods = Pick<
  AlignmentApplication,
  | 'previewArchive'
  | 'previewRestore'
  | 'previewDelete'
  | 'archive'
  | 'restore'
  | 'deletePermanently'
>;

/* ───────────────────────── Query port ───────────────────────── */

/** One row of an ordering container. */
export interface AlignmentContainerRow {
  readonly ref: EntityRef;
  readonly orderKey: string;
  readonly localRevision: number;
  /** Lifecycle state, so a command can keep a move inside the visible section. */
  readonly state: string;
}

export interface DeleteImpactRecords {
  /** Other rows whose optional foreign key names the target, in any state; cleared by `unlink_and_delete`. */
  readonly optionalReferrers: readonly {
    readonly record: CanonicalRecordState;
    readonly relationship: DeleteReferrerRelationship;
    readonly title?: string;
  }[];
  /** Active join records of the target; deleted by `unlink_and_delete`. */
  readonly activeLinks: readonly CanonicalRecordState[];
  /** Unlinked join records of the target; always deleted with the target. */
  readonly inactiveLinks: readonly CanonicalRecordState[];
  readonly activePlacements: readonly CanonicalRecordState[];
  readonly archivedPlacements: readonly CanonicalRecordState[];
  readonly activeSelections: readonly CanonicalRecordState[];
  readonly archivedSelections: readonly CanonicalRecordState[];
  /** An Outcome's Milestones in any state; they block deletion under every policy. */
  readonly requiredChildren: Bounded<{
    readonly id: UUID;
    readonly title: string;
    readonly archived: boolean;
  }>;
  /**
   * Live review items naming the target, in any state (active, archived, or in an archived
   * review), in id order. Permanent delete keeps every one and, in the same transaction, replaces
   * only its target with `{ kind: 'deleted' }`. They never block deletion.
   */
  readonly reviewItems: readonly CanonicalRecordState[];
  /**
   * Every review item row that names the target. A row missing from `reviewItems` (one a sync
   * tombstone already removed) cannot be cleared by this command, so it blocks deletion.
   */
  readonly reviewReferences: number;
  /** Routine action defaults (any generation) naming the target Project; they block deletion. */
  readonly routineDefaultReferences: number;
  readonly pendingMutation: boolean;
  readonly openConflict: boolean;
}

/**
 * Owner-scoped, prepared, indexed, read-only queries. Lists are ordered by (order key, id) and
 * bounded by `limit` (hard cap 200) with a full `total`. Implementations never write and never
 * cache planning content outside SQLite.
 */
export interface AlignmentQueryPort {
  /** Canonical record lookup used before a command opens its transaction. */
  readRecord(ownerId: OwnerId, ref: EntityRef): Promise<CanonicalRecordState | null>;
  /** Active Axes, then archived ones when `includeArchived`. */
  listAxes(
    ownerId: OwnerId,
    options: { readonly includeArchived: boolean; readonly limit: number },
  ): Promise<Bounded<AxisSummary>>;
  /** Non-archived Outcomes and Projects with no Axis. */
  listUnassigned(ownerId: OwnerId, limit: number): Promise<UnassignedView>;
  /**
   * The Axis in any state, or null. Members are never archived: Outcomes active or paused (plus
   * achieved and abandoned when `includeFinished`); Projects idea, active, blocked, or paused (plus
   * completed when `includeFinished`); Routines active or paused.
   */
  getAxis(
    ownerId: OwnerId,
    id: UUID,
    options: { readonly includeFinished: boolean; readonly limit: number },
  ): Promise<AxisDetail | null>;
  /** The Outcome in any state, or null; non-archived Milestones and primary Projects; active links. */
  getOutcome(ownerId: OwnerId, id: UUID, limit: number): Promise<OutcomeDetail | null>;
  /** The Project in any state, or null; active links, and its non-archived Actions and Notes. */
  getProject(
    ownerId: OwnerId,
    id: UUID,
    options: { readonly actionLimit: number; readonly limit: number },
  ): Promise<ProjectDetail | null>;
  /** The Milestone in any state, or null, with its active Project and Action links. */
  getMilestone(ownerId: OwnerId, id: UUID, limit: number): Promise<MilestoneDetail | null>;
  getNeighborhood(
    ownerId: OwnerId,
    focus: { readonly kind: AlignmentNodeKind; readonly id: UUID },
    limit: number,
  ): Promise<AlignmentNeighborhood | null>;
  /** Non-archived objects of a kind, optionally filtered by a case-insensitive title substring. */
  listCandidates(
    ownerId: OwnerId,
    kind: AlignmentNodeKind,
    search: string | undefined,
    limit: number,
  ): Promise<Bounded<AlignmentNode & { readonly axisId?: UUID }>>;
  /** Every non-archived row of one ordering container, in any order. */
  listContainer(ownerId: OwnerId, scope: ReorderScope): Promise<readonly AlignmentContainerRow[]>;
  /**
   * The join record of one pair in any state (active or unlinked), or null. `parentId` is the
   * Outcome or Milestone and `childId` the Project or Action, matching `alignmentLinkId`.
   */
  findLink(
    ownerId: OwnerId,
    relationship: AlignmentJoinRelationship,
    parentId: UUID,
    childId: UUID,
  ): Promise<CanonicalRecordState | null>;
  /** Counts of the target's non-archived direct children (and active join links) by child kind. */
  getArchiveImpact(
    ownerId: OwnerId,
    ref: EntityRef,
  ): Promise<Readonly<Partial<Record<AlignmentNodeKind, number>>>>;
  getDeleteImpact(ownerId: OwnerId, ref: EntityRef): Promise<DeleteImpactRecords>;
  /** Newest first; event type and time only (payloads are never read). */
  listHistory(ownerId: OwnerId, ref: EntityRef, limit: number): Promise<readonly HistoryEntry[]>;
}
