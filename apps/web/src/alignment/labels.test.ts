import { describe, expect, it } from 'vitest';

import {
  alignmentNodeKinds,
  alignmentRelationships,
  axisColorTokens,
  type CalendarDate,
} from '@yelaxis/domain';

import { ids } from './__fixtures__/alignment-fake';
import {
  axisColorLabel,
  countLabel,
  historyEventLabel,
  kindLabel,
  kindPluralLabel,
  memberCountsText,
  nextActionText,
  progressText,
  relationshipGroupLabel,
  relationshipLabel,
  stateLabel,
  targetText,
} from './labels';

const forbidden = /score|streak|\bAI\b|aligned \d+%/iu;

describe('alignment labels', () => {
  it('names every kind in singular and plural', () => {
    expect(alignmentNodeKinds.map(kindLabel)).toEqual([
      'Axis',
      'Outcome',
      'Project',
      'Milestone',
      'Action',
      'Routine',
      'Note',
    ]);
    expect(kindPluralLabel('axis')).toBe('Axes');
    expect(countLabel('outcome', 1)).toBe('1 Outcome');
    expect(countLabel('outcome', 3)).toBe('3 Outcomes');
    expect(countLabel('routine', 0)).toBe('0 Routines');
  });

  it('writes neutral member counts', () => {
    expect(memberCountsText({ outcomes: 3, projects: 2, routines: 1 })).toBe(
      '3 Outcomes · 2 Projects · 1 Routine',
    );
  });

  it('writes every state in words and reads unknown states calmly', () => {
    expect(stateLabel('action', 'in_progress')).toBe('In progress');
    expect(stateLabel('project', 'idea')).toBe('Idea');
    expect(stateLabel('outcome', 'abandoned')).toBe('Abandoned');
    expect(stateLabel('milestone', 'canceled')).toBe('Canceled');
    expect(stateLabel('routine', 'paused')).toBe('Paused');
    expect(stateLabel('axis', 'archived')).toBe('Archived');
    expect(stateLabel('note', 'something_new')).toBe('Something new');
  });

  it('labels every relationship in both directions with distinct words', () => {
    const up = alignmentRelationships.map((rule) => relationshipLabel(rule.relationship, 'up'));
    const down = alignmentRelationships.map((rule) => relationshipLabel(rule.relationship, 'down'));
    for (const label of [...up, ...down]) expect(label.trim()).not.toBe('');
    expect(new Set(up).size).toBe(up.length);
    expect(relationshipLabel('outcome_secondary_project', 'down')).toBe(
      'Also supports this Outcome',
    );
    expect(relationshipLabel('outcome_milestone', 'up')).toBe('Owns this Milestone');
    expect(relationshipGroupLabel('outcome_primary_project', 'down')).toBe('Primary Projects');
    expect(relationshipGroupLabel('milestone_action', 'down')).toBe('Supporting Actions');
  });

  it('shows progress as text, never as a milestone percentage', () => {
    expect(progressText({ mode: 'none' })).toBe('No progress measure');
    expect(progressText({ mode: 'manual', percentage: 40 })).toBe('40% (set manually)');
    expect(progressText({ mode: 'milestone_derived', completed: 0, total: 0 })).toBe(
      'No milestones yet',
    );
    expect(progressText({ mode: 'milestone_derived', completed: 2, total: 3, canceled: 1 })).toBe(
      '2 of 3 milestones completed · 1 canceled',
    );
    expect(progressText({ mode: 'milestone_derived', completed: 1, total: 1 }, 2)).toBe(
      '1 of 1 milestone completed · 2 canceled',
    );
    expect(progressText({ mode: 'milestone_derived', completed: 0, total: 0, canceled: 1 })).toBe(
      'No milestones yet · 1 canceled',
    );
  });

  it('writes targets and next actions', () => {
    expect(targetText()).toBe('No target window');
    expect(targetText(undefined, '2027-04-30' as CalendarDate)).toMatch(/^Target by /u);
    expect(nextActionText({ status: 'not_applicable' })).toBeNull();
    expect(nextActionText({ status: 'missing' })).toBe('No next action yet.');
    expect(
      nextActionText({
        status: 'present',
        action: { id: ids.longRun, title: 'Long run', state: 'planned' },
      }),
    ).toBe('Next action: Long run');
  });

  it('names Axis colors and falls back to no color', () => {
    expect(axisColorTokens.map((entry) => axisColorLabel(entry.token))).toEqual(
      axisColorTokens.map((entry) => entry.label),
    );
    expect(axisColorLabel(undefined)).toBe('No color');
    expect(axisColorLabel('neon')).toBe('No color');
  });

  it('describes history events without payloads', () => {
    expect(historyEventLabel('axis.created')).toBe('Created');
    expect(historyEventLabel('outcome.progress_set')).toBe('Progress changed');
    expect(historyEventLabel('milestone.reparented')).toBe('Moved to another Outcome');
    expect(historyEventLabel('alignment.unlinked')).toBe('Link removed');
    expect(historyEventLabel('onboarding.axis.saved')).toBe('Saved during setup');
    expect(historyEventLabel('something.else')).toBe('Changed');
  });

  it('never uses score, streak, or assistant wording', () => {
    const words = [
      ...alignmentNodeKinds.map(kindLabel),
      ...alignmentRelationships.flatMap((rule) => [
        relationshipLabel(rule.relationship, 'up'),
        relationshipLabel(rule.relationship, 'down'),
        relationshipGroupLabel(rule.relationship, 'up'),
        relationshipGroupLabel(rule.relationship, 'down'),
      ]),
      progressText({ mode: 'milestone_derived', completed: 3, total: 4, canceled: 1 }),
      progressText({ mode: 'manual', percentage: 90 }),
    ];
    for (const word of words) expect(word).not.toMatch(forbidden);
  });
});
