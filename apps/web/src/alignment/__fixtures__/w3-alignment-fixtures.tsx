/**
 * Test-only fixtures for the alignment page, relationship list, map, and link dialogs (part W3).
 * Never imported by runtime code. All data is fictional.
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
  AlignmentNodeKind,
  ApplicationResult,
  CommandReceipt,
  NoChangeReceipt,
  PlanningApplication,
} from '@yelaxis/application';
import type { CalendarDate, Instant, UUID } from '@yelaxis/domain';

import { fakePlanning, stubActions } from '../../plan/__fixtures__/c1-planning-fake';
import { PlanningProvider } from '../../plan/planning-context';

const alignmentMethods = [
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

type MissingMethod = Exclude<keyof AlignmentApplication, (typeof alignmentMethods)[number]>;
/** Compile-time proof that the fake lists every alignment facade method. */
export const everyAlignmentMethodListed: [MissingMethod] extends [never] ? true : false = true;

/** Every method present; unused ones reject so accidental calls fail loudly. */
export function fakeAlignment(overrides: Partial<AlignmentApplication> = {}): AlignmentApplication {
  const base = Object.fromEntries(
    alignmentMethods.map((name) => [
      name,
      vi.fn(() => Promise.reject(new Error(`Unexpected alignment call: ${name}`))),
    ]),
  );
  return { ...base, ...overrides } as AlignmentApplication;
}

export const uuid = (suffix: number | string): UUID =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}` as UUID;

export function node(
  kind: AlignmentNodeKind,
  id: UUID,
  title: string,
  overrides: Partial<AlignmentNode> = {},
): AlignmentNode {
  return { kind, id, title, state: 'active', archived: false, localRevision: 3, ...overrides };
}

export function edge(
  relationship: AlignmentEdge['relationship'],
  direction: AlignmentEdge['direction'],
  other: AlignmentNode,
  overrides: Partial<AlignmentEdge> = {},
): AlignmentEdge {
  return {
    relationship,
    direction,
    required: relationship === 'outcome_milestone',
    other,
    ...overrides,
  };
}

/* ───────────────────────── A fictional garden guide ───────────────────────── */

export const home = node('axis', uuid(1), 'Home and garden');
export const guide = node('outcome', uuid(2), 'Publish the garden guide');
export const outline = node('milestone', uuid(3), 'Outline approved', { localRevision: 4 });
export const draft = node('milestone', uuid(4), 'First draft done', { state: 'completed' });
export const photos = node('project', uuid(5), 'Photograph the beds', { localRevision: 6 });
export const archivedShed = node('project', uuid(6), 'Old shed notes', {
  state: 'archived',
  archived: true,
});
export const secondGuide = node('outcome', uuid(7), 'Share seeds with neighbours');
export const water = node('action', uuid(8), 'Water the seedlings', { state: 'planned' });

/** The Outcome "Publish the garden guide": its Axis above, Milestones and Projects below. */
export function outcomeNeighborhood(
  overrides: Partial<AlignmentNeighborhood> = {},
): AlignmentNeighborhood {
  return {
    focus: {
      ...guide,
      progress: { mode: 'milestone_derived', completed: 1, total: 2, canceled: 1 },
      targetEnd: '2026-12-01' as CalendarDate,
    },
    chain: [home],
    above: [edge('axis_outcome', 'up', home)],
    below: [
      edge('outcome_milestone', 'down', outline),
      edge('outcome_milestone', 'down', draft),
      edge('outcome_primary_project', 'down', photos),
      edge('outcome_secondary_project', 'down', archivedShed, {
        linkId: uuid(90),
        linkRevision: 2,
      }),
    ],
    totals: {
      axis_outcome: 1,
      outcome_milestone: 2,
      outcome_primary_project: 1,
      outcome_secondary_project: 1,
    },
    ...overrides,
  };
}

/** The Milestone "Outline approved": its required Outcome above, a Project and an Action below. */
export function milestoneNeighborhood(): AlignmentNeighborhood {
  return {
    focus: outline,
    chain: [home, guide],
    above: [edge('outcome_milestone', 'up', guide)],
    below: [
      edge('milestone_project', 'down', photos, { linkId: uuid(91), linkRevision: 1 }),
      edge('milestone_action', 'down', water, { linkId: uuid(92), linkRevision: 5 }),
    ],
    totals: { outcome_milestone: 1, milestone_project: 1, milestone_action: 1 },
  };
}

export function receipt(undoId = uuid(500)): ApplicationResult<CommandReceipt> {
  return {
    ok: true,
    value: {
      commandId: uuid(400),
      ownerId: uuid(300),
      actor: 'user',
      acceptedAt: '2026-09-28T08:00:00.000Z' as Instant,
      canonical: [],
      eventIds: [],
      undo: { available: true, undoId },
      sync: { queued: false },
    },
  };
}

export const alreadyLinked: ApplicationResult<NoChangeReceipt> = {
  ok: true,
  value: { status: 'no_change', reason: 'already_linked' },
};

export function rejected(code: string, message: string): ApplicationResult<CommandReceipt> {
  return {
    ok: false,
    error: {
      code: 'domain_rejected',
      domainError: { code: code as never, message },
    },
  };
}

/** Shows the current path and query so tests can assert URL state. */
export function LocationProbe(): ReactNode {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

/** Render one routed element inside the planning provider with alignment services. */
export function renderAlignmentTree(
  element: ReactNode,
  {
    actions = stubActions,
    alignment,
    path = '/',
    planning = fakePlanning(),
    route = '/',
  }: {
    readonly alignment: AlignmentApplication;
    readonly planning?: PlanningApplication;
    readonly actions?: ActionApplication;
    readonly path?: string;
    readonly route?: string;
  },
): ReactNode {
  return (
    <PlanningProvider planning={planning} actions={actions} alignment={alignment}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={element} />
          <Route path="*" element={<p>Elsewhere</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </PlanningProvider>
  );
}
