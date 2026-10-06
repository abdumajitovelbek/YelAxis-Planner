import type { Instant, OwnerId, IanaTimeZone, UUID } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import { createActionApplication, type ActionPlanningQueryPort } from './actions';
import { createAlignmentApplication } from './alignment';
import type { AlignmentQueryPort } from './alignment-contracts';
import { createPlanningApplication } from './planning';
import type { PlanningQueryPort } from './planning-contracts';
import { createInMemoryHarness } from './testing/in-memory-unit-of-work';
import { createTodayApplication } from './today';
import type { TodayQueryPort } from './today-contracts';

const id = '10000000-0000-4000-8000-000000000001';
const ownerId = id as OwnerId;
const revision = 1;
const interval = { date: '2026-10-04', startTime: '09:00', durationMinutes: 30 };
const ref = { kind: 'axis', id, revision };
const occurrence = { routineId: id, generation: 1, period: { kind: 'date', date: interval.date } };
const period = { kind: 'day', date: interval.date };

function captureHarness(zone: string) {
  const harness = createInMemoryHarness(ownerId, '2026-10-04T12:00:00.000Z' as Instant);
  const queries = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === 'getProfileContext')
          return () =>
            Promise.resolve({
              profileId: id as UUID,
              planningTimeZone: zone as IanaTimeZone,
              weekStart: 'monday',
            });
        if (key === 'getInboxEdge') return () => Promise.resolve(null);
        throw new Error('Unexpected query');
      },
    },
  );
  return {
    harness,
    application: createActionApplication(harness.dependencies, queries as ActionPlanningQueryPort),
  };
}

// Each case calls the real public facade with a runtime value TypeScript alone cannot protect.
const cases: readonly [string, string, readonly unknown[]][] = [
  [
    'today',
    'addFocus',
    [{ date: interval.date, target: { kind: 'action', actionId: id }, ownerId }],
  ],
  [
    'today',
    'addFocus',
    [{ date: interval.date, target: { kind: 'action', actionId: id, ownerId } }],
  ],
  ['today', 'removeFocus', [{ selectionId: id, revision, ownerId }]],
  ['today', 'reorderFocus', [{ selectionId: id, revision, direction: 'up', ownerId }]],
  [
    'today',
    'setDayFocus',
    [
      {
        date: interval.date,
        items: [{ kind: 'routine_occurrence', occurrence: { ...occurrence, ownerId } }],
      },
    ],
  ],
  [
    'today',
    'reorderFlexible',
    [{ date: interval.date, placementId: id, revision, direction: 'up', ownerId }],
  ],
  [
    'today',
    'applyEndDay',
    [{ date: interval.date, carryTo: '2026-10-05', actions: [], occurrences: [], ownerId }],
  ],
  [
    'today',
    'applyEndDay',
    [
      {
        date: interval.date,
        carryTo: '2026-10-05',
        actions: [{ actionId: id, revision, decision: { kind: 'leave', ownerId } }],
        occurrences: [],
      },
    ],
  ],
  ['actions', 'capture', [{ commandId: id, actionId: id, origin: 'global_capture' }, null]],
  [
    'actions',
    'capture',
    [{ commandId: id, actionId: id, origin: 'global_capture' }, { title: 42 }],
  ],
  [
    'actions',
    'capture',
    [
      { commandId: id, actionId: id, origin: 'global_capture' },
      { title: 'Synthetic', ownerId },
    ],
  ],
  [
    'actions',
    'capture',
    [
      { commandId: id, actionId: id, origin: 'global_capture' },
      Object.defineProperty({}, 'title', {
        get: () => {
          throw new Error('A form accessor must never be called');
        },
        enumerable: true,
      }),
    ],
  ],
  [
    'actions',
    'capture',
    [
      { commandId: id, actionId: id, origin: 'global_capture' },
      Object.assign(Object.create({ title: 'Inherited' }) as Record<string, unknown>, {
        note: 'Synthetic',
      }),
    ],
  ],
  [
    'actions',
    'capture',
    [
      { commandId: id, actionId: id, origin: 'global_capture' },
      { title: 'Synthetic', [Symbol('hidden')]: ownerId },
    ],
  ],
  [
    'actions',
    'capture',
    [
      { commandId: id, actionId: id, origin: 'global_capture' },
      {
        title: 'Synthetic',
        schedule: { date: interval.date, startTime: '09:00', endTime: '09:30', state: 'completed' },
      },
    ],
  ],
  [
    'actions',
    'capture',
    [
      { commandId: id, actionId: id, origin: 'global_capture' },
      { title: 'Synthetic', reminder: { enabled: 'false', kind: 'at' } },
    ],
  ],
  [
    'actions',
    'edit',
    [id, revision, { title: 'Synthetic', archivedAt: '2026-10-04T12:00:00.000Z' }],
  ],
  ['actions', 'triage', [id, revision, { kind: 'unexpected' }]],
  ['actions', 'triage', [id, revision, { kind: 'plan', period: { ...period, ownerId } }]],
  ['actions', 'triage', [id, revision, { kind: 'do', date: '2026-02-30' }]],
  ['actions', 'transition', [id, revision, 'unexpected']],
  ['actions', 'reorder', [id, revision, 'sideways']],
  ['actions', 'bulk', [[{ id, revision, ownerId }], { kind: 'archive' }]],
  ['actions', 'bulk', [[{ id, revision }], { kind: 'axis', axisId: id, confirmCrossAxis: 'true' }]],
  ['actions', 'deletePermanently', [id, revision, 42]],
  [
    'planning',
    'createCustomBlock',
    [{ ...interval, title: 'Synthetic', overlapAcknowledged: false, ownerId }],
  ],
  [
    'planning',
    'createCustomBlock',
    [{ ...interval, title: 'Synthetic', overlapAcknowledged: 'false' }],
  ],
  [
    'planning',
    'createCustomBlock',
    [{ ...interval, date: '2026-02-30', title: 'Synthetic', overlapAcknowledged: false }],
  ],
  [
    'planning',
    'scheduleAction',
    [
      {
        ...interval,
        actionId: id,
        revision,
        overlapAcknowledged: false,
        completedAt: '2026-10-04T12:00:00.000Z',
      },
    ],
  ],
  [
    'planning',
    'moveBlock',
    [{ ...interval, blockId: id, revision, overlapAcknowledged: false, timeZone: 'Unknown/Zone' }],
  ],
  ['planning', 'shortenBlock', [{ blockId: id, revision, durationMinutes: '30' }]],
  [
    'planning',
    'setBlockState',
    [{ blockId: id, revision, to: 'completed', alsoCompleteAction: 'false' }],
  ],
  [
    'planning',
    'keepOverlap',
    [
      {
        first: { kind: 'block', blockId: id, revision, ownerId },
        second: { kind: 'block', blockId: id, revision },
      },
    ],
  ],
  [
    'planning',
    'createCommitment',
    [{ ...interval, title: 'Synthetic', strength: 'unknown', overlapAcknowledged: false }],
  ],
  [
    'planning',
    'place',
    [{ target: { kind: 'action', id, revision }, period: { ...period, state: 'completed' } }],
  ],
  ['planning', 'unplace', [{ target: { kind: 'unknown', id, revision } }]],
  ['planning', 'carryForward', [{ actions: [{ id, revision, state: 'completed' }], period }]],
  [
    'planning',
    'reorderPlacement',
    [{ placementId: id, revision, direction: 'sideways', scope: period }],
  ],
  [
    'planning',
    'addWeekCommitment',
    [{ weekDate: interval.date, target: { kind: 'action', id, ownerId } }],
  ],
  ['planning', 'removeWeekCommitment', [{ selectionId: id, revision: NaN }]],
  ['planning', 'createRoutine', [{ title: 42, rule: {}, schedulingMode: {} }]],
  [
    'planning',
    'createRoutine',
    [
      {
        title: 'Synthetic',
        rule: {},
        schedulingMode: {},
        defaults: { note: 'Synthetic', ownerId },
      },
    ],
  ],
  [
    'planning',
    'repeatAfterAction',
    [{ title: 'Synthetic', actionId: id, rule: {}, schedulingMode: {}, ownerId }],
  ],
  [
    'planning',
    'editRoutineDetails',
    [{ routineId: id, revision, title: 'Synthetic', description: [] }],
  ],
  [
    'planning',
    'editRoutineThisAndFuture',
    [
      {
        routineId: id,
        revision,
        selectedOn: interval.date,
        rule: {},
        schedulingMode: {},
        defaults: { note: 42 },
      },
    ],
  ],
  ['planning', 'pauseRoutine', [{ routineId: id, revision, pauseOn: '2026-02-30' }]],
  ['planning', 'resumeRoutine', [{ routineId: id, revision, resumeOn: interval.date, ownerId }]],
  ['planning', 'archiveRoutine', [{ routineId: id, revision, ownerId }]],
  ['planning', 'restoreRoutine', [{ routineId: id, revision, ownerId }]],
  ['planning', 'completeOccurrence', [{ occurrence, confirmExtra: 'true' }]],
  ['planning', 'skipOccurrence', [{ occurrence: { ...occurrence, ownerId } }]],
  ['planning', 'reopenOccurrence', [{ occurrence: { ...occurrence, generation: 0 } }]],
  [
    'planning',
    'editOccurrence',
    [{ occurrence, date: interval.date, overlapAcknowledged: false, startTime: 900 }],
  ],
  [
    'planning',
    'applyTemplate',
    [
      {
        templateId: id,
        anchorDate: interval.date,
        timeZone: 'Unknown/Zone',
        selectedKeys: [],
        overlapAcknowledged: false,
      },
    ],
  ],
  ['planning', 'duplicateTemplate', [{ templateId: id, title: [], ownerId }]],
  ['planning', 'saveTemplate', [{ title: 'Synthetic', blueprint: {}, ownerId }]],
  ['planning', 'archiveTemplate', [{ templateId: id, revision, ownerId }]],
  ['planning', 'restoreTemplate', [{ templateId: id, revision, ownerId }]],
  ['planning', 'saveWeekAsTemplate', [{ weekDate: interval.date, title: 42 }]],
  [
    'planning',
    'addAvailability',
    [{ strength: 'hard', windows: [{ weekday: 'monday', start: '09:00', end: '17:00', ownerId }] }],
  ],
  [
    'planning',
    'editAvailability',
    [{ constraintId: id, revision, strength: 'hard', windows: null }],
  ],
  ['planning', 'archiveConstraint', [{ constraintId: id, revision, ownerId }]],
  ['planning', 'setCapacityCap', [{ period: 'day', minutes: '30' }]],
  ['planning', 'setMonthTheme', [{ month: '2026-10', text: 'Synthetic', ownerId }]],
  ['planning', 'clearMonthTheme', [{ month: '2026-99' }]],
  ['planning', 'setYearDirection', [{ year: '2026', text: 'Synthetic', state: 'completed' }]],
  ['planning', 'clearYearDirection', [{ year: 'invalid' }]],
  ['planning', 'changePlanningZone', [{ zone: 'Asia/Tashkent', revision, ownerId }]],
  [
    'planning',
    'setTimeBlockReminder',
    [{ blockId: id, revision, reminder: { kind: 'relative', minutesBefore: 5, ownerId } }],
  ],
  ['planning', 'turnOffTimeBlockReminder', [{ blockId: id, reminderRevision: revision, ownerId }]],
  [
    'planning',
    'setRoutineReminder',
    [{ routineId: id, revision, reminder: { minutesBefore: 5, ownerId } }],
  ],
  ['planning', 'turnOffRoutineReminder', [{ routineId: id, reminderRevision: revision, ownerId }]],
  ['alignment', 'createAxis', [{ title: 'Synthetic', ownerId }]],
  ['alignment', 'editAxis', [{ kind: 'axis', id, revision, ownerId }, { title: 'Synthetic' }]],
  [
    'alignment',
    'createOutcome',
    [
      {
        title: 'Synthetic',
        successDefinition: 'Synthetic',
        progress: { mode: 'none', percentage: 100 },
      },
    ],
  ],
  [
    'alignment',
    'editOutcome',
    [
      { kind: 'outcome', id, revision },
      { title: 'Synthetic', successDefinition: 'Synthetic', axisId: id },
    ],
  ],
  [
    'alignment',
    'setOutcomeProgress',
    [
      { kind: 'outcome', id, revision },
      { mode: 'manual', percentage: 10, state: 'completed' },
    ],
  ],
  ['alignment', 'transitionOutcome', [{ kind: 'outcome', id, revision }, 'unknown']],
  ['alignment', 'createProject', [{ title: 'Synthetic', ownerId }]],
  [
    'alignment',
    'editProject',
    [
      { kind: 'project', id, revision },
      { title: 'Synthetic', state: 'active' },
    ],
  ],
  ['alignment', 'transitionProject', [{ kind: 'project', id, revision }, 'unknown']],
  [
    'alignment',
    'createMilestone',
    [{ outcomeId: id, title: 'Synthetic', measurableCheckpoint: 'Synthetic', ownerId }],
  ],
  [
    'alignment',
    'editMilestone',
    [
      { kind: 'milestone', id, revision },
      { title: 'Synthetic', measurableCheckpoint: 'Synthetic', outcomeId: id },
    ],
  ],
  ['alignment', 'transitionMilestone', [{ kind: 'milestone', id, revision }, 'unknown']],
  ['alignment', 'reparentMilestone', [{ kind: 'milestone', id, revision }, 42]],
  [
    'alignment',
    'reorder',
    [{ target: ref, direction: 'up', scope: { container: 'axes', ownerId } }],
  ],
  [
    'alignment',
    'link',
    [{ relationship: 'milestone_action', milestoneId: id, actionId: id, replaceExisting: true }],
  ],
  [
    'alignment',
    'unlink',
    [{ relationship: 'axis_outcome', outcome: { kind: 'outcome', id, revision, ownerId } }],
  ],
  ['alignment', 'archive', [{ ...ref, ownerId }]],
  ['alignment', 'restore', [{ ...ref, ownerId }]],
  [
    'alignment',
    'deletePermanently',
    [{ target: ref, policy: 'unknown', confirmation: 'Synthetic' }],
  ],
];

describe('earlier form runtime boundaries (/)', () => {
  it.each([
    ['2026-10-04', '09:00', '09:04', 'Asia/Tashkent'],
    ['2026-11-01', '00:00', '23:59', 'America/New_York'],
  ])(
    'Capture rejects the established Time Block duration bounds (%#)',
    async (date, startTime, endTime, zone) => {
      const { harness, application } = captureHarness(zone);
      await expect(
        application.capture(application.newCaptureIntent('global_capture'), {
          title: 'Synthetic',
          schedule: { date, startTime, endTime },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'domain_rejected' } });
      expect(harness.unitOfWork.state.records.size).toBe(0);
      expect(harness.unitOfWork.state.events).toHaveLength(0);
      expect(harness.unitOfWork.state.receipts.size).toBe(0);
      expect(harness.unitOfWork.state.outbox).toHaveLength(0);
    },
  );
  it.each([
    ['2026-10-04', '09:00', '09:05', 'Asia/Tashkent'],
    ['2026-11-01', '00:00', '23:00', 'America/New_York'],
  ])(
    'Capture accepts the established interval edges (%#)',
    async (date, startTime, endTime, zone) => {
      const { application } = captureHarness(zone);
      await expect(
        application.capture(application.newCaptureIntent('global_capture'), {
          title: 'Synthetic',
          schedule: { date, startTime, endTime },
        }),
      ).resolves.toMatchObject({ ok: true });
    },
  );
  it.each(cases)(
    '%s.%s rejects malformed input before reads or writes (%#)',
    async (owner, method, args) => {
      const harness = createInMemoryHarness(ownerId, '2026-10-04T12:00:00.000Z' as Instant);
      let reads = 0;
      const queries = new Proxy(
        {},
        {
          get: () => () => {
            reads += 1;
            throw new Error('Malformed input reached an adapter');
          },
        },
      );
      const facades = {
        actions: createActionApplication(harness.dependencies, queries as ActionPlanningQueryPort),
        planning: createPlanningApplication(harness.dependencies, queries as PlanningQueryPort),
        alignment: createAlignmentApplication(harness.dependencies, queries as AlignmentQueryPort),
        today: createTodayApplication(harness.dependencies, queries as TodayQueryPort),
      };
      const facade = facades[owner as keyof typeof facades] as unknown as Record<
        string,
        (...values: readonly unknown[]) => Promise<unknown>
      >;
      const call = facade[method];
      if (call === undefined) throw new Error('Missing audited method');
      await expect(call(...args)).resolves.toMatchObject({
        ok: false,
        error: { code: 'domain_rejected' },
      });
      expect(reads).toBe(0);
      expect(harness.unitOfWork.state.records.size).toBe(0);
      expect(harness.unitOfWork.state.events).toHaveLength(0);
      expect(harness.unitOfWork.state.receipts.size).toBe(0);
      expect(harness.unitOfWork.state.outbox).toHaveLength(0);
    },
  );
});
