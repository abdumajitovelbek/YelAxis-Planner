/**
 * Test-only fakes and fictional data for the Axis area (alignment). Never imported by runtime code.
 */
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';

import type {
  ActionApplication,
  AlignmentApplication,
  AlignmentEdge,
  AlignmentNeighborhood,
  AlignmentNode,
  ApplicationResult,
  ArchiveImpactView,
  AxisDetail,
  AxisSummary,
  Bounded,
  CommandReceipt,
  DeleteImpactView,
  HistoryEntry,
  LinkedItem,
  MilestoneDetail,
  MilestoneItem,
  NoChangeReceipt,
  NodeRef,
  OutcomeDetail,
  OutcomeItem,
  PlanningApplication,
  ProjectDetail,
  ProjectItem,
  UnassignedView,
} from '@yelaxis/application';
import type {
  AlignmentNodeKind,
  CalendarDate,
  DomainError,
  EntityType,
  Instant,
  OwnerId,
  UUID,
} from '@yelaxis/domain';

import { fakePlanning } from '../../plan/__fixtures__/c1-planning-fake';
import { PlanningProvider } from '../../plan/planning-context';
import { NavigationNotice } from '../kit';

/* ───────────────────────── The fake facade ───────────────────────── */

export const alignmentMethodNames = [
  'listAxes',
  'listUnassigned',
  'getAxis',
  'getOutcome',
  'getProject',
  'getMilestone',
  'getNeighborhood',
  'listLinkCandidates',
  'listChoices',
  'previewLink',
  'previewArchive',
  'previewRestore',
  'previewDelete',
  'createAxis',
  'editAxis',
  'createOutcome',
  'editOutcome',
  'setOutcomeProgress',
  'transitionOutcome',
  'createProject',
  'editProject',
  'transitionProject',
  'createMilestone',
  'editMilestone',
  'transitionMilestone',
  'reparentMilestone',
  'reorder',
  'link',
  'unlink',
  'archive',
  'restore',
  'deletePermanently',
] as const satisfies readonly (keyof AlignmentApplication)[];

type MissingMethod = Exclude<keyof AlignmentApplication, (typeof alignmentMethodNames)[number]>;
/** Compile-time proof that the fake lists every alignment facade method. */
export const everyAlignmentMethodListed: [MissingMethod] extends [never] ? true : false = true;

/** Every method present; any call not overridden rejects so accidental calls fail loudly. */
export function fakeAlignment(overrides: Partial<AlignmentApplication> = {}): AlignmentApplication {
  const base = Object.fromEntries(
    alignmentMethodNames.map((name) => [
      name,
      vi.fn(() => Promise.reject(new Error(`Unexpected alignment call: ${name}`))),
    ]),
  );
  return { ...base, ...overrides } as AlignmentApplication;
}

/** Planning facade for alignment pages: only Undo answers (the shared runner's Undo). */
export function alignmentPlanning(
  overrides: Partial<PlanningApplication> = {},
): PlanningApplication {
  return fakePlanning({ undo: vi.fn(() => Promise.resolve(receipt())), ...overrides });
}

/** Every Action facade call rejects. */
export const stubActions = new Proxy(
  {},
  { get: () => () => Promise.reject(new Error('Unexpected Action call')) },
) as ActionApplication;

export function LocationProbe(): ReactNode {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

/**
 * A routed tree with the planning provider (alignment included), a location probe, and optionally
 * the navigation notice that app.tsx renders above its routes.
 */
export function alignmentTree(
  alignment: AlignmentApplication,
  element: ReactNode,
  options: {
    readonly path?: string;
    readonly route?: string;
    readonly planning?: PlanningApplication;
    readonly notice?: boolean;
    readonly extraRoutes?: ReactNode;
  } = {},
): ReactNode {
  return (
    <PlanningProvider
      planning={options.planning ?? alignmentPlanning()}
      actions={stubActions}
      alignment={alignment}
    >
      <MemoryRouter initialEntries={[options.path ?? '/']}>
        {options.notice === true && <NavigationNotice />}
        <Routes>
          <Route path={options.route ?? '/'} element={element} />
          {options.extraRoutes}
          <Route path="*" element={<p>Another page</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </PlanningProvider>
  );
}

/** jsdom lacks the native dialog methods used by the shared Modal. */
export function installDialogPolyfill(): void {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
}

/* ───────────────────────── Results ───────────────────────── */

export const uuid = (value: number): UUID =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}` as UUID;

export const ownerId: OwnerId = uuid(9001);
export const undoId = uuid(9002);

/** A committed receipt; `created` names the new record for create commands. */
export function receipt(
  created?: { readonly type: EntityType; readonly id: string },
  options: { readonly undo?: boolean } = {},
): ApplicationResult<CommandReceipt> {
  return {
    ok: true,
    value: {
      commandId: uuid(9003),
      ownerId,
      actor: 'user',
      acceptedAt: '2026-09-28T09:00:00.000Z' as Instant,
      canonical:
        created === undefined
          ? []
          : [{ ref: { type: created.type, id: created.id as UUID, ownerId }, localRevision: 1 }],
      eventIds: [],
      undo: options.undo === false ? { available: false } : { available: true, undoId },
      sync: { queued: false },
    },
  };
}

export function noChange(): ApplicationResult<NoChangeReceipt> {
  return { ok: true, value: { status: 'no_change', reason: 'already_linked' } };
}

export function rejected(error: DomainError): ApplicationResult<never> {
  return { ok: false, error: { code: 'domain_rejected', domainError: error } };
}

export function revisionConflict(type: EntityType, id: string): ApplicationResult<never> {
  return {
    ok: false,
    error: {
      code: 'revision_conflict',
      ref: { type, id: id as UUID, ownerId },
      expectedRevision: 1,
      actualRevision: 2,
    },
  };
}

/* ───────────────────────── Fictional data ───────────────────────── */

const date = (value: string): CalendarDate => value as CalendarDate;
const orderKey = (index: number): string => String((index + 1) * 1e9).padStart(15, '0');

export const ids = {
  health: uuid(11),
  craft: uuid(12),
  archivedAxis: uuid(13),
  halfMarathon: uuid(21),
  sleep: uuid(22),
  novel: uuid(23),
  trainingPlan: uuid(31),
  gymKit: uuid(32),
  websiteIdea: uuid(33),
  baseMiles: uuid(41),
  raceDay: uuid(42),
  longRun: uuid(51),
  stretch: uuid(61),
  note: uuid(71),
} as const;

export function bounded<T>(items: readonly T[], total = items.length): Bounded<T> {
  return { items, total };
}

export function nodeRef(id: UUID, title: string, state = 'active', archived = false): NodeRef {
  return { id, title, state, archived };
}

export function axisSummary(overrides: Partial<AxisSummary> = {}): AxisSummary {
  return {
    id: ids.health,
    localRevision: 3,
    title: 'Health',
    purpose: 'Feel strong and rested through the year.',
    color: 'emerald',
    state: 'active',
    orderKey: orderKey(0),
    counts: { outcomes: 2, projects: 1, routines: 1 },
    ...overrides,
  };
}

export function outcomeItem(overrides: Partial<OutcomeItem> = {}): OutcomeItem {
  return {
    id: ids.halfMarathon,
    localRevision: 2,
    title: 'Run a half marathon',
    successDefinition: 'Finish a spring half marathon without injury.',
    state: 'active',
    axis: nodeRef(ids.health, 'Health'),
    targetStart: date('2026-10-01'),
    targetEnd: date('2027-04-30'),
    progress: { mode: 'milestone_derived', completed: 1, total: 2, canceled: 1 },
    canceledMilestones: 1,
    orderKey: orderKey(0),
    ...overrides,
  };
}

export function projectItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id: ids.trainingPlan,
    localRevision: 4,
    title: 'Training plan',
    state: 'active',
    desiredResult: 'A sixteen-week plan on the fridge.',
    axis: nodeRef(ids.health, 'Health'),
    primaryOutcome: nodeRef(ids.halfMarathon, 'Run a half marathon'),
    orderKey: orderKey(0),
    nextAction: { status: 'missing' },
    ...overrides,
  };
}

export function milestoneItem(overrides: Partial<MilestoneItem> = {}): MilestoneItem {
  return {
    id: ids.baseMiles,
    localRevision: 2,
    title: 'Base miles',
    measurableCheckpoint: 'Run 30 km a week for four weeks.',
    state: 'active',
    outcome: nodeRef(ids.halfMarathon, 'Run a half marathon'),
    targetEnd: date('2026-12-15'),
    orderKey: orderKey(0),
    ...overrides,
  };
}

export function linkedItem<K extends AlignmentNodeKind>(
  kind: K,
  id: UUID,
  title: string,
  overrides: Partial<LinkedItem<K>> = {},
): LinkedItem<K> {
  return { kind, id, title, state: 'active', archived: false, localRevision: 1, ...overrides };
}

export const history: readonly HistoryEntry[] = [
  { eventType: 'axis.edited', occurredAt: '2026-09-27T10:15:00.000Z' as Instant },
  { eventType: 'onboarding.axis.saved', occurredAt: '2026-09-20T08:00:00.000Z' as Instant },
];

export function axisDetail(overrides: Partial<AxisDetail> = {}): AxisDetail {
  return {
    axis: axisSummary(),
    outcomes: bounded([
      outcomeItem(),
      outcomeItem({
        id: ids.sleep,
        title: 'Sleep eight hours',
        successDefinition: 'Most nights end before eleven.',
        state: 'paused',
        progress: { mode: 'manual', percentage: 40 },
        canceledMilestones: 0,
        orderKey: orderKey(1),
      }),
    ]),
    projects: bounded([
      projectItem(),
      projectItem({
        id: ids.gymKit,
        title: 'Gym kit',
        state: 'idea',
        nextAction: { status: 'not_applicable' },
        orderKey: orderKey(1),
      }),
    ]),
    routines: bounded([linkedItem('routine', ids.stretch, 'Morning stretch')]),
    reviewNote: null,
    history,
    ...overrides,
  };
}

export function unassignedView(overrides: Partial<UnassignedView> = {}): UnassignedView {
  return {
    outcomes: bounded([
      outcomeItem({
        id: ids.novel,
        title: 'Finish the novel draft',
        successDefinition: 'A full first draft exists.',
        progress: { mode: 'none' },
        canceledMilestones: 0,
      }),
    ]),
    projects: bounded([
      projectItem({
        id: ids.websiteIdea,
        title: 'Portfolio website',
        state: 'idea',
        nextAction: { status: 'not_applicable' },
      }),
    ]),
    ...overrides,
  };
}

export function outcomeDetail(overrides: Partial<OutcomeDetail> = {}): OutcomeDetail {
  return {
    outcome: outcomeItem(),
    milestones: bounded([
      milestoneItem(),
      milestoneItem({
        id: ids.raceDay,
        title: 'Race day',
        measurableCheckpoint: 'Cross the finish line.',
        orderKey: orderKey(1),
      }),
    ]),
    primaryProjects: bounded([projectItem()]),
    supportingProjects: bounded([
      linkedItem('project', ids.gymKit, 'Gym kit', { linkId: uuid(81), linkRevision: 1 }),
    ]),
    history,
    ...overrides,
  };
}

export function projectDetail(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    project: {
      ...projectItem(),
      description: 'Weekly mileage and rest days.',
      notes: 'Ask the club.',
    },
    secondaryOutcomes: [
      linkedItem('outcome', ids.sleep, 'Sleep eight hours', { linkId: uuid(82), linkRevision: 1 }),
    ],
    milestones: bounded([
      linkedItem('milestone', ids.baseMiles, 'Base miles', { linkId: uuid(83), linkRevision: 1 }),
    ]),
    actions: bounded([{ ...linkedItem('action', ids.longRun, 'Long run'), orderKey: orderKey(0) }]),
    capturedNotes: bounded([linkedItem('note', ids.note, 'Shoe sizes')]),
    history,
    ...overrides,
  };
}

export function milestoneDetail(overrides: Partial<MilestoneDetail> = {}): MilestoneDetail {
  return {
    milestone: milestoneItem(),
    axis: nodeRef(ids.health, 'Health'),
    projects: bounded([
      linkedItem('project', ids.trainingPlan, 'Training plan', {
        linkId: uuid(84),
        linkRevision: 1,
      }),
    ]),
    actions: bounded([
      linkedItem('action', ids.longRun, 'Long run', { linkId: uuid(85), linkRevision: 1 }),
    ]),
    history,
    ...overrides,
  };
}

export function alignmentNode(
  kind: AlignmentNodeKind,
  id: UUID,
  title: string,
  overrides: Partial<AlignmentNode> = {},
): AlignmentNode {
  return { kind, id, title, state: 'active', archived: false, localRevision: 1, ...overrides };
}

export function neighborhood(
  overrides: Partial<AlignmentNeighborhood> = {},
): AlignmentNeighborhood {
  const axis = alignmentNode('axis', ids.health, 'Health');
  const above: AlignmentEdge[] = [
    { relationship: 'axis_outcome', direction: 'up', required: false, other: axis },
  ];
  const below: AlignmentEdge[] = [
    {
      relationship: 'outcome_milestone',
      direction: 'down',
      required: false,
      other: alignmentNode('milestone', ids.baseMiles, 'Base miles'),
    },
    {
      relationship: 'outcome_primary_project',
      direction: 'down',
      required: false,
      other: alignmentNode('project', ids.trainingPlan, 'Training plan'),
    },
  ];
  return {
    focus: {
      ...alignmentNode('outcome', ids.halfMarathon, 'Run a half marathon'),
      progress: { mode: 'milestone_derived', completed: 1, total: 2, canceled: 1 },
    },
    chain: [axis],
    above,
    below,
    totals: { axis_outcome: 1, outcome_milestone: 1, outcome_primary_project: 1 },
    ...overrides,
  };
}

export function archiveImpact(overrides: Partial<ArchiveImpactView> = {}): ArchiveImpactView {
  return {
    target: alignmentNode('outcome', ids.halfMarathon, 'Run a half marathon'),
    activeChildren: { milestone: 2, project: 1 },
    placementKept: true,
    remindersToDisable: 0,
    ...overrides,
  };
}

export function deleteImpact(overrides: Partial<DeleteImpactView> = {}): DeleteImpactView {
  return {
    target: alignmentNode('axis', ids.health, 'Health'),
    policy: 'restrict',
    allowed: true,
    blockers: [],
    requiredChildren: bounded([]),
    optionalLinks: bounded([]),
    placements: 0,
    selections: 0,
    historyReferences: { reviews: 0, routineDefaults: 0 },
    removedHistory: { inactiveLinks: 0, archivedPlacements: 0, archivedSelections: 0 },
    pendingSync: false,
    openConflict: false,
    confirmationText: 'Health',
    ...overrides,
  };
}
