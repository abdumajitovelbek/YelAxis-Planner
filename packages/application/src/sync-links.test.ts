import { describe, expect, it } from 'vitest';

import { documentLinks } from './sync-links';

const id = (n: number) => `c0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

describe('document links', () => {
  it('reads link fields at the top level, in a target, and in a conversion', () => {
    expect(
      documentLinks({
        title: 'Call',
        axisId: id(1),
        primaryOutcomeId: id(2),
        convertedTo: { type: 'project', id: id(3) },
      }),
    ).toEqual([
      { entityType: 'axis', id: id(1) },
      { entityType: 'outcome', id: id(2) },
      { entityType: 'project', id: id(3) },
    ]);
    expect(
      documentLinks({
        target: { kind: 'routine_occurrence', routineOccurrenceId: id(4) },
        supersededById: id(5),
      }),
    ).toEqual([
      { entityType: 'routine_occurrence', id: id(4) },
      { entityType: 'time_block', id: id(5) },
    ]);
  });

  it('ignores values that are not links', () => {
    expect(
      documentLinks({
        title: id(1),
        orderKey: 'a0',
        projectId: 'not an id',
        target: { kind: 'custom', title: 'Deep work' },
        convertedTo: { type: 'axis', id: id(2) },
      }),
    ).toEqual([]);
    expect(documentLinks(null)).toEqual([]);
  });
});
