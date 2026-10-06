import type { Instant, OnboardingDraft, OwnerId, ProfileId, UUID } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import {
  createOnboardingApplication,
  type OnboardingArtifacts,
  type OnboardingCommit,
  type OnboardingCommand,
  type OnboardingPersistencePort,
  type OnboardingRecordMutation,
  type OnboardingState,
} from './onboarding';

// Noon in Tashkent on Thursday 2026-08-06 (Sunday week 2026-08-02..08), and on Wednesday
// 2026-08-12 of the next week (2026-08-09..15).
const setupDay = '2026-08-06T07:00:00.000Z' as Instant;
const nextWeek = '2026-08-12T07:00:00.000Z' as Instant;
const ownerId = '10000000-0000-4000-8000-0000000000aa' as OwnerId;
const profileId = '10000000-0000-4000-8000-0000000000bb' as ProfileId;

const defaults = {
  planningTimeZone: 'Asia/Tashkent',
  weekStart: 'sunday' as const,
  timeFormat: '12_hour' as const,
  locale: 'en',
};

function draft(actionTitle = 'Draft the proposal outline'): OnboardingDraft {
  return {
    identity: { preferredName: 'Sam', locale: 'en' },
    defaults,
    context: {},
    axes: ['Study'],
    outcome: {
      title: 'Submit a clear proposal',
      successDefinition: 'The reviewer can decide without asking for missing information.',
      axisIndex: 0,
    },
    week: { commitments: [], actionTitle },
  };
}

function initialState(): OnboardingState {
  return {
    ownerId,
    profileId,
    profileRevision: 1,
    status: 'not_started',
    step: 'welcome',
    completedSteps: [],
    skippedSteps: [],
    handbook: { status: 'not_started', lesson: 0, completedLessons: [] },
    draft: draft(),
    artifacts: { axisIds: [], commitments: [] },
    today: { date: '', weekStartDate: '', weekEndDate: '', axes: [], commitments: [] },
  };
}

/** The `count`th id the test provider generates. */
function generatedId(count: number): UUID {
  return `20000000-0000-4000-8000-${count.toString(16).padStart(12, '0')}` as UUID;
}

/** Keeps the state a port would return and records every commit the application builds. */
function setup() {
  let state = initialState();
  let now = setupDay;
  const commits: OnboardingCommit[] = [];
  const persistence: OnboardingPersistencePort = {
    initialize: () => Promise.resolve(state),
    load: () => Promise.resolve(state),
    commit(command) {
      commits.push(command);
      state = {
        ...state,
        profileRevision: state.profileRevision + 1,
        status: command.profile.status,
        step: command.profile.step,
        completedSteps: command.profile.completedSteps,
        skippedSteps: command.profile.skippedSteps,
        draft: command.profile.draft ?? state.draft,
        artifacts: command.profile.artifacts,
      };
      return Promise.resolve(state);
    },
  };
  let id = 1;
  const application = createOnboardingApplication(persistence, {
    clock: { now: () => now },
    ids: {
      next: () => {
        const next = generatedId(id);
        id += 1;
        return next;
      },
    },
  });
  return {
    application,
    commits,
    setNow: (value: Instant) => {
      now = value;
    },
    /** What the SQLite adapter's load shows after the starter Action is permanently deleted. */
    forgetStarterAction: () => {
      const { actionId, placementId, focusId, weekSelectionId, ...remaining } = state.artifacts;
      expect([actionId, placementId, focusId, weekSelectionId]).not.toContain(undefined);
      state = { ...state, artifacts: remaining satisfies OnboardingArtifacts };
    },
  };
}

function kinds(commit: OnboardingCommit | undefined): OnboardingRecordMutation['kind'][] {
  return commit?.records.map((record) => record.kind) ?? [];
}

const starterPlanKinds: readonly OnboardingRecordMutation['kind'][] = [
  'placement',
  'focus',
  'week_selection',
];

function starterPlan(commit: OnboardingCommit | undefined) {
  return commit?.records.filter((record) => starterPlanKinds.includes(record.kind)) ?? [];
}

async function complete(
  application: ReturnType<typeof setup>['application'],
  actionTitle?: string,
) {
  const result = await application.execute({
    kind: 'complete',
    draft: draft(actionTitle),
    handbookStatus: 'skipped',
  });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

async function rerun(application: ReturnType<typeof setup>['application'], actionTitle?: string) {
  expect((await application.execute({ kind: 'rerun' })).ok).toBe(true);
  return complete(application, actionTitle);
}

describe('onboarding starter Action plan', () => {
  it('places the new starter Action on its day, day focus, and week on the first completion', async () => {
    const { application, commits } = setup();

    const completed = await complete(application);

    const commit = commits.at(-1);
    const { actionId, placementId, focusId, weekSelectionId } = completed.artifacts;
    expect(kinds(commit)).toEqual([
      'axis',
      'outcome',
      'action',
      'placement',
      'focus',
      'week_selection',
    ]);
    expect(starterPlan(commit)).toEqual([
      {
        kind: 'placement',
        id: placementId,
        actionId,
        localDate: '2026-08-06',
        sortKey: 'onboarding-01',
      },
      { kind: 'focus', id: focusId, actionId, localDate: '2026-08-06', sortKey: 'onboarding-01' },
      {
        kind: 'week_selection',
        id: weekSelectionId,
        actionId,
        startDate: '2026-08-02',
        endDate: '2026-08-08',
        weekStart: 'sunday',
        sortKey: 'onboarding-01',
      },
    ]);
    expect(commit?.eventIds).toHaveLength((commit?.records.length ?? 0) + 1);
  });

  it('never sends a placement, focus, or week record on a rerun; the other records keep their ids', async () => {
    const { application, commits } = setup();
    const first = await complete(application);
    const firstCommit = commits.at(-1);

    const replay = await rerun(application);

    const commit = commits.at(-1);
    expect(starterPlan(commit)).toEqual([]);
    expect(kinds(commit)).toEqual(['axis', 'outcome', 'action']);
    expect(replay.artifacts).toEqual(first.artifacts);
    expect(commit?.records).toEqual(
      firstCommit?.records.filter(({ kind }) => !starterPlanKinds.includes(kind)),
    );
    expect(commit?.eventIds).toHaveLength((commit?.records.length ?? 0) + 1);
  });

  it('never re-dates the starter plan when setup is rerun on a later day and week', async () => {
    const { application, commits, setNow } = setup();
    const first = await complete(application);

    setNow(nextWeek);
    const replay = await rerun(application, 'Draft the proposal outline, second pass');

    const commit = commits.at(-1);
    expect(starterPlan(commit)).toEqual([]);
    expect(commit?.records).toContainEqual(
      expect.objectContaining({
        kind: 'action',
        id: first.artifacts.actionId,
        title: 'Draft the proposal outline, second pass',
      }),
    );
    expect(replay.artifacts).toEqual(first.artifacts);
  });

  it('places a replacement starter Action under new ids after the first one was deleted', async () => {
    const { application, commits, setNow, forgetStarterAction } = setup();
    const first = await complete(application);
    forgetStarterAction();

    setNow(nextWeek);
    const replay = await rerun(application, 'Outline the proposal again');

    const next = replay.artifacts;
    for (const key of ['actionId', 'placementId', 'focusId', 'weekSelectionId'] as const) {
      expect(next[key]).toBeDefined();
      expect(next[key]).not.toBe(first.artifacts[key]);
    }
    const commit = commits.at(-1);
    expect(kinds(commit)).toEqual([
      'axis',
      'outcome',
      'action',
      'placement',
      'focus',
      'week_selection',
    ]);
    expect(starterPlan(commit)).toEqual([
      expect.objectContaining({
        id: next.placementId,
        actionId: next.actionId,
        localDate: '2026-08-12',
      }),
      expect.objectContaining({
        id: next.focusId,
        actionId: next.actionId,
        localDate: '2026-08-12',
      }),
      expect.objectContaining({
        id: next.weekSelectionId,
        actionId: next.actionId,
        startDate: '2026-08-09',
        endDate: '2026-08-15',
      }),
    ]);
    expect(commit?.eventIds).toHaveLength((commit?.records.length ?? 0) + 1);
  });
});

describe('onboarding runtime command boundary', () => {
  const malformed: readonly unknown[] = [
    null,
    { kind: 'unknown' },
    { kind: 'navigate', step: 'unknown' },
    { kind: 'rerun', ownerId },
    { kind: 'save_handbook', status: 'unknown', lesson: 0, completedLessons: [] },
    { kind: 'save_handbook', status: 'in_progress', lesson: 0, completedLessons: null },
    { kind: 'save_step', step: 'welcome', draft: draft() },
    { kind: 'save_step', step: 'defaults', draft: draft(), skipped: 'false' },
    { kind: 'complete', draft: draft(), handbookStatus: 'unknown' },
    { kind: 'start', draft: { ...draft(), ownerId } },
    { kind: 'start', draft: { ...draft(), identity: { preferredName: 42, locale: 'en' } } },
    {
      kind: 'start',
      draft: {
        ...draft(),
        context: { boundary: { text: 'Synthetic', strength: 'hard', sensitivity: 'private' } },
      },
    },
    {
      kind: 'complete',
      draft: { ...draft(), week: { commitments: [], actionTitle: 'x'.repeat(201) } },
      handbookStatus: 'skipped',
    },
    {
      kind: 'complete',
      draft: {
        ...draft(),
        week: {
          actionTitle: 'Synthetic',
          commitments: [
            {
              title: 'Synthetic',
              date: '2026-10-04',
              start: '09:00',
              end: '09:30',
              strength: 'hard',
              confirmed: 'true',
            },
          ],
        },
      },
      handbookStatus: 'skipped',
    },
  ];

  it.each(malformed)(
    'rejects malformed input without persisting a draft or profile (%#)',
    async (value) => {
      const { application, commits } = setup();
      const before = await application.load();
      await expect(application.execute(value as OnboardingCommand)).resolves.toMatchObject({
        ok: false,
      });
      expect(commits).toHaveLength(0);
      expect(await application.load()).toEqual(before);
    },
  );
});

describe('onboarding commit outbox ids', () => {
  it('allocates the group id and the Profile operation id from the injected ids, after the event ids', async () => {
    const { application, commits } = setup();

    const saved = await application.execute({
      kind: 'save_handbook',
      status: 'in_progress',
      lesson: 1,
      completedLessons: [0],
    });

    expect(saved.ok).toBe(true);
    expect(commits.at(-1)).toMatchObject({
      records: [],
      commandId: generatedId(1),
      eventIds: [generatedId(2)],
      outbox: { mutationGroupId: generatedId(3), operationIds: [generatedId(4)] },
    });
  });

  it('allocates one operation id for the Profile and for each record, all distinct', async () => {
    const { application, commits } = setup();

    await complete(application);

    const commit = commits.at(-1);
    if (commit === undefined) throw new Error('Missing commit');
    expect(commit.records).not.toHaveLength(0);
    expect(commit.outbox.operationIds).toHaveLength(commit.records.length + 1);
    const allocated = [
      ...commit.records.map(({ id }) => id),
      commit.commandId,
      ...commit.eventIds,
      commit.outbox.mutationGroupId,
      ...commit.outbox.operationIds,
    ];
    expect(new Set(allocated).size).toBe(allocated.length);
    expect(allocated.every((id) => id.startsWith('20000000-0000-4000-8000-'))).toBe(true);
  });
});
