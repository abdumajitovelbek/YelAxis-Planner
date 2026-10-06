import { describe, expect, it } from 'vitest';

import {
  alignmentFieldLimits,
  alignmentKinds,
  alignmentLinkEntityType,
  alignmentLinkId,
  alignmentLiveStates,
  alignmentRelationshipRules,
  alignmentRelationships,
  alignmentRelationshipsAbove,
  alignmentRelationshipsBelow,
  axisColorTokens,
  countMilestoneProgress,
  createEntityRef,
  deriveNameBasedUuid,
  isAlignmentRelationship,
  isAxisColorToken,
  isCrossAxis,
  outcomeProgress,
  outcomeProgressStatus,
  parseUUID,
  projectNextAction,
  restoreAlignmentState,
  spacedOrderKey,
  transitionAlignmentObject,
  validateAlignmentInput,
  validateAlignmentLink,
  validateAlignmentUnlink,
  validateAxisSnapshot,
  validateDeleteConfirmation,
  validateMilestoneSnapshot,
  validateOutcomeProgressInput,
  yelaxisDerivedIdNamespace,
  type ActionState,
  type AlignmentKind,
  type AlignmentLinkRequest,
  type AlignmentRelationship,
  type AlignmentState,
  type DomainResult,
  type EntityRef,
  type EntityType,
  type MilestoneState,
  type OutcomeProgress,
  type ProjectState,
  type UUID,
} from './index.js';

const expectValue = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

const failure = (result: DomainResult<unknown>) => {
  if (result.ok) throw new Error('Expected a rejection.');
  return result.error;
};

const reasonOf = (result: DomainResult<unknown>): unknown => failure(result).details?.['reason'];

const uuid = (suffix: string): UUID =>
  expectValue(parseUUID(`0190c2b1-7d9a-7cc1-8be5-${suffix.padStart(12, '0')}`));
const ownerId = uuid('a0');
const otherOwnerId = uuid('a1');
const ref = <Type extends EntityType>(type: Type, suffix: string, owner = ownerId) =>
  createEntityRef(type, uuid(suffix), owner);

/* ───────────────────────── Lifecycle ───────────────────────── */

const allStates: { readonly [K in AlignmentKind]: readonly AlignmentState<K>[] } = {
  axis: ['active', 'archived'],
  outcome: ['active', 'paused', 'achieved', 'abandoned', 'archived'],
  project: ['idea', 'active', 'blocked', 'paused', 'completed', 'archived'],
  milestone: ['active', 'completed', 'canceled', 'archived'],
};

/** The manual (non-archive) transitions of state-machines.md. */
const manualTransitions: {
  readonly [K in AlignmentKind]: Readonly<Record<string, readonly string[]>>;
} = {
  axis: {},
  outcome: {
    active: ['paused', 'achieved', 'abandoned'],
    paused: ['active', 'achieved', 'abandoned'],
    achieved: ['active'],
    abandoned: ['active'],
  },
  milestone: {
    active: ['completed', 'canceled'],
    completed: ['active'],
    canceled: ['active'],
  },
  project: {
    idea: ['active', 'paused'],
    active: ['blocked', 'paused', 'completed'],
    blocked: ['active', 'paused', 'completed'],
    paused: ['active', 'completed'],
    completed: ['active'],
  },
};

const snapshot = <K extends AlignmentKind>(
  kind: K,
  state: AlignmentState<K>,
  desiredResult?: string,
) => ({
  state,
  ...(state === 'archived' ? { stateBeforeArchive: alignmentLiveStates[kind][0] } : {}),
  ...(desiredResult === undefined ? {} : { desiredResult }),
});

describe('transitionAlignmentObject', () => {
  it('accepts exactly the manual transitions of every kind, for every state pair', () => {
    let checked = 0;
    for (const kind of alignmentKinds) {
      const states = allStates[kind] as readonly string[];
      for (const from of states) {
        for (const to of states) {
          const result = transitionAlignmentObject(
            kind,
            snapshot(kind, from as AlignmentState, 'Ship the beta'),
            to as AlignmentState,
          );
          const legal = manualTransitions[kind][from]?.includes(to) === true;
          expect(result.ok, `${kind} ${from} -> ${to}`).toBe(legal);
          if (legal) expect(result).toEqual({ ok: true, value: to });
          else expect(failure(result).code).toBe('invalid_transition');
          checked += 1;
        }
      }
    }
    expect(checked).toBe(4 + 25 + 36 + 16);
  });

  it('sends archive and restore to their own commands', () => {
    expect(reasonOf(transitionAlignmentObject('outcome', { state: 'active' }, 'archived'))).toBe(
      'archive_command',
    );
    expect(
      reasonOf(
        transitionAlignmentObject(
          'milestone',
          { state: 'archived', stateBeforeArchive: 'completed' },
          'completed',
        ),
      ),
    ).toBe('restore_first');
    expect(reasonOf(transitionAlignmentObject('axis', { state: 'active' }, 'archived'))).toBe(
      'archive_command',
    );
  });

  it('explains same-state and unavailable changes calmly', () => {
    const same = failure(transitionAlignmentObject('outcome', { state: 'paused' }, 'paused'));
    expect(same.details).toMatchObject({ reason: 'same_state', from: 'paused', to: 'paused' });
    expect(same.message).toBe('This Outcome is already paused.');
    const blocked = failure(
      transitionAlignmentObject('project', { state: 'idea', desiredResult: 'Launch' }, 'completed'),
    );
    expect(blocked.details).toMatchObject({ reason: 'not_allowed', entityType: 'project' });
    expect(blocked.message).toBe('This Project cannot change from idea to completed.');
  });

  it('requires a desired result to leave idea, without a partial state', () => {
    for (const to of ['active', 'paused'] as const) {
      const result = transitionAlignmentObject('project', { state: 'idea' }, to);
      expect(failure(result).code).toBe('invalid_transition');
      expect(reasonOf(result)).toBe('desired_result_required');
      expect(
        reasonOf(transitionAlignmentObject('project', { state: 'idea', desiredResult: '  ' }, to)),
      ).toBe('desired_result_required');
      expect(
        transitionAlignmentObject('project', { state: 'idea', desiredResult: 'Launch' }, to),
      ).toEqual({ ok: true, value: to });
    }
    expect(failure(transitionAlignmentObject('project', { state: 'idea' }, 'active')).message).toBe(
      'Add a desired result before activating this Project.',
    );
  });

  it('never lets Axes change state outside archive and restore', () => {
    expect(reasonOf(transitionAlignmentObject('axis', { state: 'active' }, 'active'))).toBe(
      'same_state',
    );
  });
});

describe('restoreAlignmentState', () => {
  it('returns the recorded state when it is still valid', () => {
    expect(
      restoreAlignmentState('outcome', { state: 'archived', stateBeforeArchive: 'achieved' }),
    ).toEqual({ ok: true, value: 'achieved' });
    expect(
      restoreAlignmentState('milestone', { state: 'archived', stateBeforeArchive: 'canceled' }),
    ).toEqual({ ok: true, value: 'canceled' });
    expect(
      restoreAlignmentState('project', {
        state: 'archived',
        stateBeforeArchive: 'blocked',
        desiredResult: 'Launch',
      }),
    ).toEqual({ ok: true, value: 'blocked' });
    expect(
      restoreAlignmentState('project', { state: 'archived', stateBeforeArchive: 'idea' }),
    ).toEqual({ ok: true, value: 'idea' });
  });

  it('falls back to active, and a Project without a desired result to idea', () => {
    for (const kind of ['axis', 'outcome', 'milestone'] as const) {
      expect(restoreAlignmentState(kind, { state: 'archived' })).toEqual({
        ok: true,
        value: 'active',
      });
      expect(
        restoreAlignmentState(kind, {
          state: 'archived',
          stateBeforeArchive: 'archived' as never,
        }),
      ).toEqual({ ok: true, value: 'active' });
    }
    expect(restoreAlignmentState('project', { state: 'archived' })).toEqual({
      ok: true,
      value: 'idea',
    });
    expect(
      restoreAlignmentState('project', { state: 'archived', desiredResult: 'Launch' }),
    ).toEqual({ ok: true, value: 'active' });
    expect(
      restoreAlignmentState('project', { state: 'archived', stateBeforeArchive: 'active' }),
    ).toEqual({ ok: true, value: 'idea' });
    expect(
      restoreAlignmentState('project', {
        state: 'archived',
        stateBeforeArchive: 'bogus' as ProjectState as Exclude<ProjectState, 'archived'>,
        desiredResult: 'Launch',
      }),
    ).toEqual({ ok: true, value: 'active' });
  });

  it('refuses to restore something that is not archived', () => {
    expect(reasonOf(restoreAlignmentState('axis', { state: 'active' }))).toBe('not_archived');
  });
});

/* ───────────────────────── Input limits ───────────────────────── */

describe('validateAlignmentInput', () => {
  const text = (length: number) => 'x'.repeat(length);

  it('trims titles and enforces the per-kind title caps', () => {
    const caps: readonly [AlignmentKind, number][] = [
      ['axis', 80],
      ['outcome', 120],
      ['project', 200],
      ['milestone', 200],
    ];
    const base = {
      axis: {},
      outcome: { successDefinition: 'Done' },
      project: {},
      milestone: { measurableCheckpoint: 'Measured' },
    } as const;
    for (const [kind, cap] of caps) {
      const ok = validateAlignmentInput(kind, {
        ...base[kind],
        title: `  ${text(cap)}  `,
      });
      expect(expectValue(ok).title).toBe(text(cap));
      const long = validateAlignmentInput(kind, { ...base[kind], title: text(cap + 1) });
      expect(failure(long)).toMatchObject({
        code: 'invalid_value',
        details: { reason: 'title_too_long', field: 'title' },
      });
      expect(failure(long).message).toBe(`Keep the title to ${String(cap)} characters or fewer.`);
      expect(reasonOf(validateAlignmentInput(kind, { ...base[kind], title: '   ' }))).toBe(
        'title_required',
      );
    }
    expect(alignmentFieldLimits).toMatchObject({
      axisTitle: 80,
      outcomeTitle: 120,
      projectTitle: 200,
      milestoneTitle: 200,
      longText: 2000,
      projectNotes: 10000,
    });
  });

  it('caps long text at 2,000 characters and Project notes at 10,000', () => {
    const cases: readonly [AlignmentKind, Record<string, string>, string][] = [
      ['axis', { title: 'Health', purpose: text(2001) }, 'purpose'],
      ['outcome', { title: 'Run', successDefinition: text(2001) }, 'successDefinition'],
      ['project', { title: 'Site', desiredResult: text(2001) }, 'desiredResult'],
      ['project', { title: 'Site', description: text(2001) }, 'description'],
      ['project', { title: 'Site', notes: text(10_001) }, 'notes'],
      ['milestone', { title: '5k', measurableCheckpoint: text(2001) }, 'measurableCheckpoint'],
    ];
    for (const [kind, input, field] of cases) {
      const result = validateAlignmentInput(kind, input as never);
      expect(failure(result)).toMatchObject({ details: { reason: 'text_too_long', field } });
    }
    expect(
      failure(validateAlignmentInput('project', { title: 'Site', notes: text(10_001) })).message,
    ).toBe('Keep the notes to 10,000 characters or fewer.');
    expect(
      expectValue(
        validateAlignmentInput('project', {
          title: 'Site',
          desiredResult: text(2000),
          description: text(2000),
          notes: text(10_000),
        }),
      ),
    ).toMatchObject({ desiredResult: text(2000), notes: text(10_000) });
  });

  it('requires success definitions and measurable checkpoints', () => {
    const outcome = validateAlignmentInput('outcome', { title: 'Run', successDefinition: ' ' });
    expect(failure(outcome)).toMatchObject({
      details: { reason: 'text_required', field: 'successDefinition' },
    });
    expect(failure(outcome).message).toBe('Add a success definition.');
    expect(
      reasonOf(validateAlignmentInput('milestone', { title: '5k', measurableCheckpoint: '' })),
    ).toBe('text_required');
  });

  it('drops blank optional text and keeps the rest trimmed', () => {
    expect(
      expectValue(
        validateAlignmentInput('project', {
          title: ' Launch site ',
          desiredResult: ' Site is live ',
          description: '   ',
          notes: '',
        }),
      ),
    ).toEqual({ title: 'Launch site', desiredResult: 'Site is live' });
    expect(
      expectValue(validateAlignmentInput('axis', { title: 'Health', purpose: '  ', icon: '' })),
    ).toEqual({ title: 'Health' });
  });

  it('accepts only the named Axis color tokens and simple icon names', () => {
    expect(axisColorTokens.map((entry) => entry.token)).toEqual([
      'cyan',
      'violet',
      'emerald',
      'amber',
      'rose',
      'slate',
    ]);
    expect(axisColorTokens.every((entry) => entry.label.length > 0)).toBe(true);
    for (const { token } of axisColorTokens) {
      expect(isAxisColorToken(token)).toBe(true);
      expect(
        expectValue(validateAlignmentInput('axis', { title: 'Health', color: token })).color,
      ).toBe(token);
    }
    for (const color of ['green', '#00ff00', 'Cyan', ' cyan']) {
      expect(reasonOf(validateAlignmentInput('axis', { title: 'Health', color }))).toBe('color');
    }
    for (const icon of ['leaf', 'a', 'heart-2', `a${'b'.repeat(31)}`]) {
      expect(expectValue(validateAlignmentInput('axis', { title: 'Health', icon })).icon).toBe(
        icon,
      );
    }
    for (const icon of ['Leaf', '2leaf', 'leaf icon', '-leaf', `a${'b'.repeat(32)}`]) {
      expect(reasonOf(validateAlignmentInput('axis', { title: 'Health', icon }))).toBe('icon');
    }
  });

  it('accepts inclusive, optional, one-sided target windows with start on or before end', () => {
    const outcome = { title: 'Run', successDefinition: 'Finish' };
    expect(
      expectValue(
        validateAlignmentInput('outcome', {
          ...outcome,
          targetStart: '2026-10-01',
          targetEnd: '2026-10-01',
        }),
      ),
    ).toMatchObject({ targetStart: '2026-10-01', targetEnd: '2026-10-01' });
    expect(
      expectValue(validateAlignmentInput('outcome', { ...outcome, targetEnd: '2026-12-31' })),
    ).toEqual({ ...outcome, targetEnd: '2026-12-31' });
    expect(
      expectValue(
        validateAlignmentInput('milestone', {
          title: '5k',
          measurableCheckpoint: 'Run',
          targetStart: ' ',
        }),
      ),
    ).toEqual({ title: '5k', measurableCheckpoint: 'Run' });
    const reversed = validateAlignmentInput('project', {
      title: 'Site',
      targetStart: '2026-12-01',
      targetEnd: '2026-11-30',
    });
    expect(failure(reversed)).toMatchObject({
      code: 'invalid_value',
      details: { reason: 'target_window', field: 'targetEnd' },
    });
    expect(
      failure(validateAlignmentInput('outcome', { ...outcome, targetStart: '2026-02-30' })),
    ).toMatchObject({ details: { reason: 'target_window', field: 'targetStart' } });
  });

  it('fails closed on malformed runtime input', () => {
    expect(reasonOf(validateAlignmentInput('axis', null as never))).toBe('input');
    expect(reasonOf(validateAlignmentInput('axis', { title: 42 } as never))).toBe('title_required');
    expect(reasonOf(validateAlignmentInput('axis', { title: 'Health', purpose: 7 } as never))).toBe(
      'text_invalid',
    );
  });
});

describe('snapshot invariants', () => {
  const axis = { title: 'Health', orderKey: 'onboarding-01', state: 'active' } as const;
  const milestone = {
    title: 'First 5k',
    measurableCheckpoint: 'Run 5k',
    outcomeId: uuid('b1'),
    orderKey: spacedOrderKey(0),
    state: 'active',
  } as const;

  it('accepts stored documents without applying input caps', () => {
    expect(validateAxisSnapshot({ ...axis, title: 'x'.repeat(500) }).ok).toBe(true);
    expect(
      validateAxisSnapshot({
        ...axis,
        state: 'archived',
        stateBeforeArchive: 'active',
        archivedAt: '2026-09-27T09:00:00.000Z',
      }).ok,
    ).toBe(true);
    expect(validateMilestoneSnapshot({ ...milestone, title: 'x'.repeat(500) }).ok).toBe(true);
    expect(
      validateMilestoneSnapshot({
        ...milestone,
        targetWindow: { start: '2026-10-01', end: '2026-10-31' } as never,
      }).ok,
    ).toBe(true);
  });

  it('rejects broken Axis and Milestone snapshots', () => {
    expect(reasonOf(validateAxisSnapshot({ ...axis, title: ' ' }))).toBe('axis_required_text');
    expect(reasonOf(validateAxisSnapshot({ ...axis, state: 'archived' }))).toBe(
      'axis_archive_metadata',
    );
    expect(reasonOf(validateMilestoneSnapshot({ ...milestone, outcomeId: 'nope' }))).toBe(
      'milestone_outcome',
    );
    expect(reasonOf(validateMilestoneSnapshot({ ...milestone, measurableCheckpoint: '' }))).toBe(
      'milestone_required_text',
    );
    expect(
      reasonOf(
        validateMilestoneSnapshot({
          ...milestone,
          state: 'archived',
          archivedAt: '2026-09-27T09:00:00.000Z',
        }),
      ),
    ).toBe('milestone_archive_metadata');
    expect(
      reasonOf(
        validateMilestoneSnapshot({
          ...milestone,
          targetStart: '2026-11-01',
          targetEnd: '2026-10-01',
        }),
      ),
    ).toBe('milestone_target_window');
  });
});

/* ───────────────────────── Progress ───────────────────────── */

describe('Outcome progress', () => {
  it('normalizes progress choices and drops the percentage outside manual mode', () => {
    expect(validateOutcomeProgressInput({ mode: 'none' })).toEqual({
      ok: true,
      value: { mode: 'none' },
    });
    expect(
      validateOutcomeProgressInput({ mode: 'milestone_derived', percentage: 40 } as never),
    ).toEqual({ ok: true, value: { mode: 'milestone_derived' } });
    for (const percentage of [0, 40, 100]) {
      expect(validateOutcomeProgressInput({ mode: 'manual', percentage })).toEqual({
        ok: true,
        value: { mode: 'manual', percentage },
      });
    }
    for (const percentage of [-1, 101, 12.5, Number.NaN, '40']) {
      const result = validateOutcomeProgressInput({ mode: 'manual', percentage } as never);
      expect(failure(result)).toMatchObject({
        code: 'invalid_value',
        details: { reason: 'progress_percentage', field: 'percentage' },
      });
      expect(failure(result).message).toBe('Enter a whole number from 0 to 100.');
    }
    expect(reasonOf(validateOutcomeProgressInput({ mode: 'score' } as never))).toBe(
      'progress_mode',
    );
  });

  it('counts completed out of active plus completed; canceled separately; archived never', () => {
    const states: MilestoneState[] = [
      'active',
      'completed',
      'completed',
      'canceled',
      'archived',
      'active',
    ];
    expect(countMilestoneProgress(states)).toEqual({ completed: 2, total: 4, canceled: 1 });
    expect(countMilestoneProgress([])).toEqual({ completed: 0, total: 0, canceled: 0 });
    expect(countMilestoneProgress(['canceled', 'archived'])).toEqual({
      completed: 0,
      total: 0,
      canceled: 1,
    });
  });

  it('shows each progress mode without a percentage for Milestone-derived progress', () => {
    const counts = { completed: 2, total: 4, canceled: 1 };
    const cases: readonly [OutcomeProgress, unknown, string][] = [
      [{ mode: 'none' }, { mode: 'none' }, 'no_measure'],
      [{ mode: 'manual', percentage: 40 }, { mode: 'manual', percentage: 40 }, 'manual_percentage'],
      [
        { mode: 'milestone_derived' },
        { mode: 'milestone_derived', completed: 2, total: 4, canceled: 1 },
        'milestone_count',
      ],
    ];
    for (const [progress, summary, status] of cases) {
      const result = outcomeProgress(progress, counts);
      expect(result).toEqual(summary);
      expect(outcomeProgressStatus(result)).toBe(status);
      expect(result).not.toHaveProperty('score');
    }
    const empty = outcomeProgress(
      { mode: 'milestone_derived' },
      countMilestoneProgress(['canceled']),
    );
    expect(empty).toEqual({ mode: 'milestone_derived', completed: 0, total: 0, canceled: 1 });
    expect(outcomeProgressStatus(empty)).toBe('no_milestones');
  });
});

/* ───────────────────────── Next action ───────────────────────── */

describe('projectNextAction', () => {
  const action = (id: string, state: ActionState, orderKey: string) => ({ id, state, orderKey });

  it('applies only to active Projects', () => {
    for (const state of ['idea', 'blocked', 'paused', 'completed', 'archived'] as const) {
      expect(projectNextAction(state, [action('a', 'planned', 'k')])).toEqual({
        status: 'not_applicable',
      });
    }
  });

  it('picks the first unfinished Action by order key, then id', () => {
    const actions = [
      action('d', 'completed', '000000000000001'),
      action('c', 'in_progress', spacedOrderKey(1)),
      action('b', 'inbox', spacedOrderKey(0)),
      action('a', 'scheduled', spacedOrderKey(0)),
      action('e', 'canceled', '000000000000000'),
      action('f', 'archived', '000000000000000'),
    ];
    expect(projectNextAction('active', actions)).toEqual({
      status: 'present',
      action: action('a', 'scheduled', spacedOrderKey(0)),
    });
    expect(
      projectNextAction('active', [action('p', 'planned', 'z'), action('q', 'inbox', 'y')]),
    ).toMatchObject({ status: 'present', action: { id: 'q' } });
  });

  it('reports a missing next action without blocking anything', () => {
    expect(projectNextAction('active', [])).toEqual({ status: 'missing' });
    expect(
      projectNextAction('active', [
        action('a', 'completed', 'a'),
        action('b', 'canceled', 'b'),
        action('c', 'archived', 'c'),
      ]),
    ).toEqual({ status: 'missing' });
  });
});

/* ───────────────────────── Relationships ───────────────────────── */

const catalog: readonly [AlignmentRelationship, EntityType, EntityType, 'fk' | 'join'][] = [
  ['axis_outcome', 'axis', 'outcome', 'fk'],
  ['axis_project', 'axis', 'project', 'fk'],
  ['axis_routine', 'axis', 'routine', 'fk'],
  ['outcome_milestone', 'outcome', 'milestone', 'fk'],
  ['outcome_primary_project', 'outcome', 'project', 'fk'],
  ['outcome_secondary_project', 'outcome', 'project', 'join'],
  ['project_action', 'project', 'action', 'fk'],
  ['project_note', 'project', 'note', 'fk'],
  ['milestone_project', 'milestone', 'project', 'join'],
  ['milestone_action', 'milestone', 'action', 'join'],
];

const endpointTypes: readonly EntityType[] = [
  'axis',
  'outcome',
  'project',
  'milestone',
  'action',
  'routine',
  'note',
  'routine_action_defaults',
  'project_secondary_outcome',
];

const linkRequest = (
  relationship: AlignmentRelationship,
  parent: EntityRef,
  child: EntityRef,
  extra: Partial<AlignmentLinkRequest> = {},
): AlignmentLinkRequest => ({
  relationship,
  parent,
  child,
  parentArchived: false,
  childArchived: false,
  ...extra,
});

describe('relationship catalog', () => {
  it('lists every allowed relationship once, in display order, with typed storage', () => {
    expect(alignmentRelationships.map((rule) => rule.relationship)).toEqual(
      catalog.map(([relationship]) => relationship),
    );
    for (const [relationship, parentKind, childKind, storage] of catalog) {
      expect(alignmentRelationshipRules[relationship]).toMatchObject({
        relationship,
        parentKind,
        childKind,
        storage,
      });
      expect(isAlignmentRelationship(relationship)).toBe(true);
    }
    expect(alignmentRelationshipRules.outcome_milestone).toMatchObject({
      required: true,
      childCardinality: 'exactly_one',
      foreignKey: 'outcomeId',
    });
    expect(alignmentRelationshipRules.project_note.displayOnly).toBe(true);
    expect(alignmentRelationshipRules.axis_routine.displayOnly).toBe(true);
    expect(
      alignmentRelationships.filter((rule) => rule.required).map((rule) => rule.relationship),
    ).toEqual(['outcome_milestone']);
    for (const value of ['axis_action', 'routine_defaults_project', 'outcome_axis', 42, null])
      expect(isAlignmentRelationship(value)).toBe(false);
  });

  it('derives direct parents and children per kind in a fixed order', () => {
    const names = (rules: readonly { readonly relationship: string }[]) =>
      rules.map((rule) => rule.relationship);
    expect(names(alignmentRelationshipsAbove('project'))).toEqual([
      'axis_project',
      'outcome_primary_project',
      'outcome_secondary_project',
      'milestone_project',
    ]);
    expect(names(alignmentRelationshipsAbove('action'))).toEqual([
      'project_action',
      'milestone_action',
    ]);
    expect(names(alignmentRelationshipsAbove('axis'))).toEqual([]);
    expect(names(alignmentRelationshipsBelow('axis'))).toEqual([
      'axis_outcome',
      'axis_project',
      'axis_routine',
    ]);
    expect(names(alignmentRelationshipsBelow('outcome'))).toEqual([
      'outcome_milestone',
      'outcome_primary_project',
      'outcome_secondary_project',
    ]);
    expect(names(alignmentRelationshipsBelow('milestone'))).toEqual([
      'milestone_project',
      'milestone_action',
    ]);
    expect(names(alignmentRelationshipsBelow('action'))).toEqual([]);
  });

  it('derives one stable join id per pair and join entity types', () => {
    const outcome = uuid('b1');
    const project = uuid('c1');
    const id = alignmentLinkId('outcome_secondary_project', outcome, project);
    expect(id).toBe(
      deriveNameBasedUuid(
        yelaxisDerivedIdNamespace,
        `outcome_secondary_project:${outcome}:${project}`,
      ),
    );
    expect(alignmentLinkId('outcome_secondary_project', outcome, project)).toBe(id);
    expect(alignmentLinkId('outcome_secondary_project', project, outcome)).not.toBe(id);
    expect(alignmentLinkId('milestone_project', outcome, project)).not.toBe(id);
    expect(alignmentLinkEntityType('outcome_secondary_project')).toBe('project_secondary_outcome');
    expect(alignmentLinkEntityType('milestone_project')).toBe('milestone_project');
    expect(alignmentLinkEntityType('milestone_action')).toBe('milestone_action');
  });

  it('treats Action and Project as cross-Axis only when both Axes are named and differ', () => {
    expect(isCrossAxis(uuid('1'), uuid('2'))).toBe(true);
    expect(isCrossAxis(uuid('1'), uuid('1'))).toBe(false);
    expect(isCrossAxis(undefined, uuid('1'))).toBe(false);
    expect(isCrossAxis(uuid('1'), undefined)).toBe(false);
  });
});

describe('validateAlignmentLink', () => {
  it('links every catalog pair and refuses every swapped or other endpoint pair', () => {
    let refused = 0;
    for (const [relationship, parentType, childType] of catalog) {
      expect(
        validateAlignmentLink(
          linkRequest(relationship, ref(parentType, '10'), ref(childType, '20')),
        ),
      ).toEqual({
        ok: true,
        value: { status: 'create', relationship, crossAxis: false },
      });
      expect(
        failure(
          validateAlignmentLink(
            linkRequest(relationship, ref(childType, '20'), ref(parentType, '10')),
          ),
        ).code,
      ).toBe('unsupported_relationship');
      for (const left of endpointTypes) {
        for (const right of endpointTypes) {
          if (left === parentType && right === childType) continue;
          const result = validateAlignmentLink(
            linkRequest(relationship, ref(left, '10'), ref(right, '20')),
          );
          expect(failure(result).code, `${relationship} ${left} -> ${right}`).toBe(
            'unsupported_relationship',
          );
          refused += 1;
        }
      }
    }
    expect(refused).toBe(catalog.length * (endpointTypes.length ** 2 - 1));
  });

  it('refuses unknown relationship names and cross-owner endpoints', () => {
    const unknown = validateAlignmentLink(
      linkRequest('outcome_axis' as AlignmentRelationship, ref('outcome', '1'), ref('axis', '2')),
    );
    expect(failure(unknown)).toMatchObject({ code: 'unsupported_relationship' });
    expect(failure(unknown).message).toBe('These items cannot be linked that way.');
    for (const [relationship, parentType, childType] of catalog) {
      const result = validateAlignmentLink(
        linkRequest(relationship, ref(parentType, '1'), ref(childType, '2', otherOwnerId)),
      );
      expect(failure(result).code).toBe('owner_mismatch');
    }
  });

  it('treats an active duplicate as an existing no-op before any other rule', () => {
    for (const [relationship, parentType, childType, storage] of catalog) {
      const parent = ref(parentType, '1');
      const duplicate =
        storage === 'fk' ? { currentParentId: parent.id } : { activeLinkExists: true };
      expect(
        validateAlignmentLink(
          linkRequest(relationship, parent, ref(childType, '2'), {
            ...duplicate,
            parentArchived: true,
            primaryOutcomeId: parent.id,
            outcomeIsSupporting: true,
          }),
        ),
      ).toMatchObject({ ok: true, value: { status: 'existing', relationship } });
    }
  });

  it('blocks new links to an archived endpoint on either side', () => {
    for (const [relationship, parentType, childType] of catalog) {
      for (const side of [{ parentArchived: true }, { childArchived: true }]) {
        const result = validateAlignmentLink(
          linkRequest(relationship, ref(parentType, '1'), ref(childType, '2'), side),
        );
        expect(failure(result)).toMatchObject({
          code: 'archived_endpoint',
          details: { relationship },
        });
        expect(failure(result).message).toBe('Restore the archived item before linking it.');
      }
    }
  });

  it('requires explicit replacement for an occupied single-valued link', () => {
    const previous = uuid('99');
    for (const [relationship, parentType, childType, storage] of catalog) {
      const parent = ref(parentType, '1');
      const child = ref(childType, '2');
      const occupied = validateAlignmentLink(
        linkRequest(relationship, parent, child, { currentParentId: previous }),
      );
      if (storage === 'join') {
        expect(expectValue(occupied)).toEqual({ status: 'create', relationship, crossAxis: false });
        continue;
      }
      expect(failure(occupied)).toMatchObject({
        code: 'cardinality_violation',
        details: { reason: 'occupied', relationship },
      });
      expect(
        validateAlignmentLink(
          linkRequest(relationship, parent, child, {
            currentParentId: previous,
            replaceExisting: true,
          }),
        ),
      ).toEqual({
        ok: true,
        value: { status: 'create', relationship, crossAxis: false, replacesParentId: previous },
      });
    }
    expect(
      failure(
        validateAlignmentLink(
          linkRequest('project_action', ref('project', '1'), ref('action', '2'), {
            currentParentId: previous,
          }),
        ),
      ).message,
    ).toBe(
      'This Action is already linked to another Project. Confirm the replacement to change it.',
    );
    expect(
      failure(
        validateAlignmentLink(
          linkRequest('outcome_milestone', ref('outcome', '1'), ref('milestone', '2'), {
            currentParentId: previous,
          }),
        ),
      ).message,
    ).toBe('A milestone always belongs to one Outcome. Move it to another Outcome instead.');
  });

  it('keeps supporting and primary Outcomes distinct', () => {
    const outcome = ref('outcome', '1');
    const project = ref('project', '2');
    const secondary = validateAlignmentLink(
      linkRequest('outcome_secondary_project', outcome, project, { primaryOutcomeId: outcome.id }),
    );
    expect(failure(secondary)).toMatchObject({
      code: 'cardinality_violation',
      details: { reason: 'secondary_is_primary' },
    });
    expect(failure(secondary).message).toBe(
      "This Outcome is already the Project's primary Outcome.",
    );
    expect(
      validateAlignmentLink(
        linkRequest('outcome_secondary_project', outcome, project, { primaryOutcomeId: uuid('3') }),
      ).ok,
    ).toBe(true);
    const primary = validateAlignmentLink(
      linkRequest('outcome_primary_project', outcome, project, {
        outcomeIsSupporting: true,
        currentParentId: uuid('3'),
        replaceExisting: true,
      }),
    );
    expect(failure(primary)).toMatchObject({
      code: 'cardinality_violation',
      details: { reason: 'primary_is_secondary' },
    });
    expect(failure(primary).message).toContain('Remove it as a supporting Outcome first.');
  });

  it('asks for cross-Axis confirmation only for Action to Project links', () => {
    const project = ref('project', '1');
    const action = ref('action', '2');
    const axes = { projectAxisId: uuid('a'), actionAxisId: uuid('b') };
    const unconfirmed = validateAlignmentLink(linkRequest('project_action', project, action, axes));
    expect(failure(unconfirmed)).toMatchObject({ code: 'cross_axis_confirmation_required' });
    expect(failure(unconfirmed).message).toBe(
      'This Action is in a different Axis than the Project. Confirm to link them.',
    );
    expect(
      validateAlignmentLink(
        linkRequest('project_action', project, action, { ...axes, confirmCrossAxis: true }),
      ),
    ).toEqual({
      ok: true,
      value: { status: 'create', relationship: 'project_action', crossAxis: true },
    });
    expect(
      validateAlignmentLink(
        linkRequest('project_action', project, action, {
          projectAxisId: uuid('a'),
          actionAxisId: uuid('a'),
        }),
      ),
    ).toMatchObject({ ok: true, value: { crossAxis: false } });
    expect(
      validateAlignmentLink(linkRequest('milestone_action', ref('milestone', '1'), action, axes)),
    ).toMatchObject({ ok: true, value: { status: 'create', crossAxis: false } });
  });
});

describe('validateAlignmentUnlink', () => {
  it('always allows unlinking except the required Outcome owner of a Milestone', () => {
    for (const [relationship, parentType, childType] of catalog) {
      const result = validateAlignmentUnlink({
        relationship,
        parent: ref(parentType, '1'),
        child: ref(childType, '2'),
      });
      if (relationship === 'outcome_milestone') {
        expect(failure(result)).toMatchObject({ code: 'required_relationship' });
        expect(failure(result).message).toBe(
          'A milestone always belongs to one Outcome. Move it to another Outcome instead.',
        );
      } else {
        expect(result).toEqual({ ok: true, value: { unlinkOnly: true } });
      }
    }
  });

  it('refuses swapped endpoints, unknown names, and cross-owner endpoints', () => {
    for (const [relationship, parentType, childType] of catalog) {
      expect(
        failure(
          validateAlignmentUnlink({
            relationship,
            parent: ref(childType, '2'),
            child: ref(parentType, '1'),
          }),
        ).code,
      ).toBe('unsupported_relationship');
      expect(
        failure(
          validateAlignmentUnlink({
            relationship,
            parent: ref(parentType, '1'),
            child: ref(childType, '2', otherOwnerId),
          }),
        ).code,
      ).toBe('owner_mismatch');
    }
    expect(
      failure(
        validateAlignmentUnlink({
          relationship: 'axis_action' as AlignmentRelationship,
          parent: ref('axis', '1'),
          child: ref('action', '2'),
        }),
      ).code,
    ).toBe('unsupported_relationship');
  });
});

describe('validateDeleteConfirmation', () => {
  it('requires the exact current title', () => {
    expect(validateDeleteConfirmation('Run a 10k', 'Run a 10k')).toEqual({ ok: true, value: true });
    for (const typed of ['run a 10k', 'Run a 10k ', '', 'Run'])
      expect(failure(validateDeleteConfirmation('Run a 10k', typed))).toMatchObject({
        code: 'invalid_value',
        message: 'Type the exact title to confirm.',
        details: { reason: 'delete_confirmation' },
      });
  });
});
