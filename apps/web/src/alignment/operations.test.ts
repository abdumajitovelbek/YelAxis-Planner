import { describe, expect, it } from 'vitest';

import type {
  AlignmentEdge,
  AlignmentNeighborhood,
  AlignmentNode,
  AlignmentNodeKind,
} from '@yelaxis/application';
import { alignmentRelationships, type UUID } from '@yelaxis/domain';

import {
  edgeGroups,
  linkableRelationships,
  neighborhoodSummary,
  nodePath,
  operationName,
  operationsFor,
  parseAlignmentFocus,
} from './operations';

const uuid = (suffix: string): UUID =>
  `00000000-0000-4000-8000-${suffix.padStart(12, '0')}` as UUID;

function node(
  kind: AlignmentNodeKind,
  title: string,
  overrides: Partial<AlignmentNode> = {},
): AlignmentNode {
  return {
    kind,
    id: uuid(String(title.length + kind.length)),
    title,
    state: 'active',
    archived: false,
    localRevision: 1,
    ...overrides,
  };
}

function edge(
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

const ids = (operations: readonly { readonly id: string }[]): readonly string[] =>
  operations.map((operation) => operation.id);

describe('operationsFor', () => {
  it('offers Inspect, Link, and Open for an active focus', () => {
    const outcome = node('outcome', 'Ship the garden guide');
    const operations = operationsFor(outcome);
    expect(ids(operations)).toEqual(['inspect', 'link', 'open']);
    expect(operations.map(operationName)).toEqual([
      'Inspect Ship the garden guide',
      'Link… Ship the garden guide',
      'Open Ship the garden guide',
    ]);
  });

  it('never offers Link for an archived focus', () => {
    const archived = node('project', 'Old shed plans', { state: 'archived', archived: true });
    expect(ids(operationsFor(archived))).toEqual(['inspect', 'open']);
  });

  it('offers no Link for kinds whose relationships are display-only, and no page for Notes', () => {
    expect(ids(operationsFor(node('routine', 'Morning pages')))).toEqual(['inspect', 'open']);
    expect(ids(operationsFor(node('note', 'Seed list')))).toEqual(['inspect']);
  });

  it('moves a Milestone to another Outcome through its required edge, never unlinks it', () => {
    const milestone = node('milestone', 'First draft done');
    const outcome = node('outcome', 'Finish the guide');
    const fromMilestone = operationsFor(milestone, edge('outcome_milestone', 'up', outcome));
    expect(ids(fromMilestone)).toEqual(['inspect', 'center', 'reparent', 'open']);
    expect(fromMilestone.find((operation) => operation.id === 'reparent')).toEqual({
      id: 'reparent',
      label: 'Move to another Outcome…',
      target: 'First draft done',
    });

    const fromOutcome = operationsFor(outcome, edge('outcome_milestone', 'down', milestone));
    expect(ids(fromOutcome)).toEqual(['inspect', 'center', 'reparent', 'open']);
    expect(fromOutcome.find((operation) => operation.id === 'reparent')?.target).toBe(
      'First draft done',
    );
  });

  it('does not move an archived Milestone', () => {
    const outcome = node('outcome', 'Finish the guide');
    const archived = node('milestone', 'Old checkpoint', { state: 'archived', archived: true });
    expect(ids(operationsFor(outcome, edge('outcome_milestone', 'down', archived)))).toEqual([
      'inspect',
      'center',
      'open',
    ]);
  });

  it('unlinks optional links even when the other object is archived', () => {
    const milestone = node('milestone', 'First draft done');
    const archivedProject = node('project', 'Paused research', {
      state: 'archived',
      archived: true,
    });
    const operations = operationsFor(
      milestone,
      edge('milestone_project', 'down', archivedProject, {
        linkId: uuid('900'),
        linkRevision: 2,
      }),
    );
    expect(ids(operations)).toEqual(['inspect', 'center', 'unlink', 'open']);
    expect(operations.map(operationName)).toContain('Unlink… Paused research');
  });

  it('never unlinks display-only relationships', () => {
    const axis = node('axis', 'Home');
    const project = node('project', 'Kitchen');
    expect(ids(operationsFor(axis, edge('axis_routine', 'down', node('routine', 'Tidy'))))).toEqual(
      ['inspect', 'center', 'open'],
    );
    expect(
      ids(operationsFor(project, edge('project_note', 'down', node('note', 'Paint colours')))),
    ).toEqual(['inspect', 'center']);
  });

  it('never offers Link on an edge and never offers both Unlink and Move', () => {
    for (const rule of alignmentRelationships) {
      for (const direction of ['up', 'down'] as const) {
        for (const archived of [false, true]) {
          const focusKind = direction === 'up' ? rule.childKind : rule.parentKind;
          const otherKind = direction === 'up' ? rule.parentKind : rule.childKind;
          const focus = node(focusKind, 'Focus', { archived });
          const other = node(otherKind, 'Other', { archived });
          const operations = ids(
            operationsFor(
              focus,
              edge(rule.relationship, direction, other, { required: rule.required }),
            ),
          );
          expect(operations).not.toContain('link');
          expect(operations.includes('unlink') && operations.includes('reparent')).toBe(false);
          if (rule.required) expect(operations).not.toContain('unlink');
          expect(new Set(operations).size).toBe(operations.length);
        }
      }
    }
  });
});

describe('linkableRelationships', () => {
  it('lists every relationship a person can link from each kind', () => {
    const relationships = (kind: AlignmentNodeKind) =>
      linkableRelationships(kind).map((rule) => rule.relationship);
    expect(relationships('axis')).toEqual(['axis_outcome', 'axis_project']);
    expect(relationships('outcome')).toEqual([
      'axis_outcome',
      'outcome_primary_project',
      'outcome_secondary_project',
    ]);
    expect(relationships('project')).toEqual([
      'axis_project',
      'outcome_primary_project',
      'outcome_secondary_project',
      'project_action',
      'milestone_project',
    ]);
    expect(relationships('milestone')).toEqual(['milestone_project', 'milestone_action']);
    expect(relationships('action')).toEqual(['project_action', 'milestone_action']);
    expect(relationships('routine')).toEqual([]);
    expect(relationships('note')).toEqual([]);
  });
});

describe('neighborhood helpers', () => {
  const outcome = node('outcome', 'Ship the garden guide');
  const neighborhood: AlignmentNeighborhood = {
    focus: outcome,
    chain: [node('axis', 'Home')],
    above: [edge('axis_outcome', 'up', node('axis', 'Home'))],
    below: [
      edge('outcome_milestone', 'down', node('milestone', 'Outline')),
      edge('outcome_milestone', 'down', node('milestone', 'Draft')),
      edge('outcome_primary_project', 'down', node('project', 'Photos')),
    ],
    totals: { axis_outcome: 1, outcome_milestone: 3, outcome_primary_project: 1 },
  };

  it('groups edges in catalog order with full totals', () => {
    expect(
      edgeGroups(neighborhood, 'down').map((group) => [
        group.relationship,
        group.edges.length,
        group.total,
      ]),
    ).toEqual([
      ['outcome_milestone', 2, 3],
      ['outcome_primary_project', 1, 1],
    ]);
    expect(edgeGroups(neighborhood, 'up').map((group) => group.relationship)).toEqual([
      'axis_outcome',
    ]);
  });

  it('summarizes the neighborhood in words, with counts by kind', () => {
    expect(neighborhoodSummary(neighborhood)).toBe(
      'Outcome “Ship the garden guide”. Above: 1 Axis. Below: 3 Milestones, 1 Project.',
    );
    expect(
      neighborhoodSummary({
        focus: node('axis', 'Home', { archived: true, state: 'archived' }),
        chain: [],
        above: [],
        below: [],
        totals: {},
      }),
    ).toBe('Axis “Home”, archived. Above: nothing. Below: nothing.');
  });
});

describe('nodePath and focus parsing', () => {
  it('opens the page of each kind that has one', () => {
    const id = uuid('7');
    expect(nodePath({ kind: 'axis', id })).toBe(`/axis/${id}`);
    expect(nodePath({ kind: 'outcome', id })).toBe(`/outcomes/${id}`);
    expect(nodePath({ kind: 'project', id })).toBe(`/projects/${id}`);
    expect(nodePath({ kind: 'milestone', id })).toBe(`/milestones/${id}`);
    expect(nodePath({ kind: 'action', id })).toBe(`/actions/${id}`);
    expect(nodePath({ kind: 'routine', id })).toBe(`/plan/routines/${id}`);
    expect(nodePath({ kind: 'note', id })).toBeNull();
  });

  it('parses the focus parameter strictly', () => {
    const id = uuid('42');
    expect(parseAlignmentFocus(null)).toBeNull();
    expect(parseAlignmentFocus(`outcome:${id}`)).toEqual({ kind: 'outcome', id });
    expect(parseAlignmentFocus(`project:${id.toUpperCase()}`)).toEqual({ kind: 'project', id });
    expect(parseAlignmentFocus('')).toBe('invalid');
    expect(parseAlignmentFocus(id)).toBe('invalid');
    expect(parseAlignmentFocus(`goal:${id}`)).toBe('invalid');
    expect(parseAlignmentFocus('outcome:not-a-uuid')).toBe('invalid');
    expect(parseAlignmentFocus(`outcome:${id}:extra`)).toBe('invalid');
  });
});
