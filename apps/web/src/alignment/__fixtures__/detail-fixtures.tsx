/**
 * Test-only fakes and fictional data for the Outcome, Project, and Milestone detail pages. Never
 * imported by runtime code.
 */
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';

import type {
  ActionApplication,
  AlignmentApplication,
  AlignmentNodeKind,
  ApplicationResult,
  CapacitySettings,
  CommandReceipt,
  HistoryEntry,
  LinkedItem,
  MilestoneDetail,
  MilestoneItem,
  NodeRef,
  OutcomeDetail,
  OutcomeItem,
  PlanningApplication,
  ProjectDetail,
  ProjectItem,
} from '@yelaxis/application';
import type {
  CalendarDate,
  CommandId,
  IanaTimeZone,
  Instant,
  MonthKey,
  OwnerId,
  UUID,
} from '@yelaxis/domain';

import { fakePlanning, LocationProbe } from '../../plan/__fixtures__/c1-planning-fake';
import { PlanningProvider } from '../../plan/planning-context';

/* ───────────────────────── Typed fake facade ───────────────────────── */

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
/** Compile-time proof that the fake lists every facade method. */
export const everyAlignmentMethodListed: [MissingMethod] extends [never] ? true : false = true;

/** Every method present; unused ones reject so an unexpected call fails loudly. */
export function fakeAlignment(overrides: Partial<AlignmentApplication> = {}): AlignmentApplication {
  const base = Object.fromEntries(
    alignmentMethods.map((name) => [
      name,
      vi.fn(() => Promise.reject(new Error(`Unexpected alignment call: ${name}`))),
    ]),
  );
  return { ...base, ...overrides } as AlignmentApplication;
}

export const uuid = (value: number): UUID =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}` as UUID;

export const ids = {
  axis: uuid(11),
  outcome: uuid(21),
  otherOutcome: uuid(22),
  milestone: uuid(31),
  milestoneTwo: uuid(32),
  project: uuid(41),
  projectTwo: uuid(42),
  action: uuid(51),
  actionTwo: uuid(52),
  actionThree: uuid(53),
  note: uuid(61),
  link: uuid(71),
  linkTwo: uuid(72),
  placement: uuid(81),
  undo: uuid(91),
} as const;

export function receipt(): ApplicationResult<CommandReceipt> {
  return {
    ok: true,
    value: {
      commandId: 'command-1' as CommandId,
      ownerId: 'owner-1' as OwnerId,
      actor: 'user',
      acceptedAt: '2026-09-29T08:00:00.000Z' as Instant,
      canonical: [],
      eventIds: [],
      undo: { available: true, undoId: ids.undo },
      sync: { queued: false },
    },
  };
}

export const settings: CapacitySettings = {
  profile: {
    profileId: uuid(103),
    planningTimeZone: 'UTC' as IanaTimeZone,
    weekStart: 'monday',
    timeFormat: '24_hour',
  },
  availability: [],
  rules: { windows: [], caps: [] },
};

/** The planning facade with settings in UTC; other calls reject unless overridden. */
export function planningFake(overrides: Partial<PlanningApplication> = {}): PlanningApplication {
  return fakePlanning({ getCapacitySettings: vi.fn().mockResolvedValue(settings), ...overrides });
}

/** An Action facade whose calls reject unless overridden. */
export function actionsFake(overrides: Partial<ActionApplication> = {}): ActionApplication {
  const unused = (name: string) => () =>
    Promise.reject(new Error(`Unexpected Action call: ${name}`));
  return {
    newCaptureIntent: () => {
      throw new Error('Unexpected capture intent');
    },
    capture: unused('capture'),
    listInbox: unused('listInbox'),
    listAllInbox: unused('listAllInbox'),
    getAction: unused('getAction'),
    listAxes: unused('listAxes'),
    listProjects: unused('listProjects'),
    listMilestones: unused('listMilestones'),
    edit: unused('edit'),
    triage: unused('triage'),
    transition: unused('transition'),
    reorder: unused('reorder'),
    bulk: unused('bulk'),
    undo: unused('undo'),
    deletePermanently: unused('deletePermanently'),
    ...overrides,
  };
}

/** Render one page route inside the providers the app composes. */
export function renderDetail(input: {
  readonly path: string;
  readonly route: string;
  readonly element: ReactNode;
  readonly alignment: AlignmentApplication;
  readonly planning?: PlanningApplication;
  readonly actions?: ActionApplication;
}): RenderResult {
  return render(
    <PlanningProvider
      planning={input.planning ?? planningFake()}
      actions={input.actions ?? actionsFake()}
      alignment={input.alignment}
    >
      <MemoryRouter initialEntries={[input.path]}>
        <Routes>
          <Route path={input.route} element={input.element} />
          <Route path="*" element={<p>Elsewhere</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </PlanningProvider>,
  );
}

/* ───────────────────────── Fictional data ───────────────────────── */

const date = (value: string): CalendarDate => value as CalendarDate;

/** Drop an optional field (fixtures cannot set it to undefined under exact optional types). */
export function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

export const node = (id: UUID, title: string, state = 'active', archived = false): NodeRef => ({
  id,
  title,
  state,
  archived,
});

export function linked<K extends AlignmentNodeKind>(
  kind: K,
  id: UUID,
  title: string,
  extra: Partial<LinkedItem<K>> = {},
): LinkedItem<K> {
  return { id, title, state: 'active', archived: false, kind, localRevision: 2, ...extra };
}

export const history: readonly HistoryEntry[] = [
  { eventType: 'alignment.linked', occurredAt: '2026-09-20T10:00:00.000Z' as Instant },
  { eventType: 'outcome.created', occurredAt: '2026-09-01T09:00:00.000Z' as Instant },
];

export function outcomeItem(overrides: Partial<OutcomeItem> = {}): OutcomeItem {
  return {
    id: ids.outcome,
    localRevision: 4,
    title: 'Finish the manuscript',
    successDefinition: 'The manuscript is with the editor',
    state: 'active',
    axis: node(ids.axis, 'Craft'),
    targetStart: date('2026-08-01'),
    targetEnd: date('2026-12-18'),
    progress: { mode: 'milestone_derived', completed: 1, total: 2, canceled: 1 },
    canceledMilestones: 1,
    placement: { id: ids.placement, period: { kind: 'month', month: '2026-08' as MonthKey } },
    orderKey: '000001000000000',
    ...overrides,
  };
}

export function milestoneItem(overrides: Partial<MilestoneItem> = {}): MilestoneItem {
  return {
    id: ids.milestone,
    localRevision: 3,
    title: 'Draft chapter two',
    measurableCheckpoint: 'Chapter two has a complete first draft',
    state: 'active',
    outcome: node(ids.outcome, 'Finish the manuscript'),
    targetStart: date('2026-08-01'),
    targetEnd: date('2026-08-28'),
    placement: { id: uuid(82), period: { kind: 'month', month: '2026-08' as MonthKey } },
    orderKey: '000001000000000',
    ...overrides,
  };
}

export function projectItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id: ids.project,
    localRevision: 5,
    title: 'Research notes',
    state: 'active',
    desiredResult: 'Sources for every chapter are organized',
    axis: node(ids.axis, 'Craft'),
    primaryOutcome: node(ids.outcome, 'Finish the manuscript'),
    targetStart: date('2026-09-01'),
    targetEnd: date('2026-10-30'),
    orderKey: '000001000000000',
    nextAction: {
      status: 'present',
      action: { id: ids.action, title: 'Outline scene list', state: 'planned' },
    },
    ...overrides,
  };
}

export function outcomeDetail(overrides: Partial<OutcomeDetail> = {}): OutcomeDetail {
  return {
    outcome: outcomeItem(),
    milestones: {
      items: [
        milestoneItem(),
        milestoneItem({
          id: ids.milestoneTwo,
          title: 'Revise chapter two',
          measurableCheckpoint: 'Editor notes are addressed',
          state: 'completed',
          orderKey: '000002000000000',
        }),
      ],
      total: 2,
    },
    primaryProjects: { items: [projectItem()], total: 1 },
    supportingProjects: {
      items: [
        linked('project', ids.projectTwo, 'Workshop feedback', {
          linkId: ids.link,
          linkRevision: 1,
        }),
      ],
      total: 1,
    },
    history,
    ...overrides,
  };
}

export function projectDetail(
  overrides: Partial<ProjectDetail> = {},
  project: Partial<ProjectDetail['project']> = {},
): ProjectDetail {
  return {
    project: {
      ...projectItem(),
      description: 'Collect and tag sources',
      notes: 'Ask the library about archives',
      placement: { id: uuid(83), period: { kind: 'month', month: '2026-09' as MonthKey } },
      ...project,
    },
    secondaryOutcomes: [
      linked('outcome', ids.otherOutcome, 'Share early chapters', {
        linkId: ids.link,
        linkRevision: 2,
      }),
    ],
    milestones: {
      items: [
        linked('milestone', ids.milestone, 'Draft chapter two', {
          linkId: ids.linkTwo,
          linkRevision: 1,
        }),
      ],
      total: 1,
    },
    actions: {
      items: [
        {
          ...linked('action', ids.action, 'Outline scene list', { state: 'planned' }),
          orderKey: 'a1',
        },
        {
          ...linked('action', ids.actionTwo, 'Order reference books', { state: 'completed' }),
          orderKey: 'a2',
        },
      ],
      total: 2,
    },
    capturedNotes: {
      items: [linked('note', ids.note, 'Archive hours change in winter')],
      total: 1,
    },
    history,
    ...overrides,
  };
}

export function milestoneDetail(
  overrides: Partial<MilestoneDetail> = {},
  milestone: Partial<MilestoneItem> = {},
): MilestoneDetail {
  return {
    milestone: milestoneItem(milestone),
    axis: node(ids.axis, 'Craft'),
    projects: {
      items: [
        linked('project', ids.project, 'Research notes', { linkId: ids.link, linkRevision: 3 }),
      ],
      total: 1,
    },
    actions: {
      items: [
        linked('action', ids.action, 'Outline scene list', {
          state: 'planned',
          linkId: ids.linkTwo,
          linkRevision: 1,
        }),
      ],
      total: 1,
    },
    history,
    ...overrides,
  };
}

/** Planning-content words the pages must never show (no scores, streaks, or assistant wording). */
export const forbiddenCopy = /\bscore\b|\bstreak\b|\bAI\b|aligned \d+%/iu;
