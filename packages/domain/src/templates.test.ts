import { describe, expect, it } from 'vitest';

import { parseTemplateBlueprint, previewTemplateApplication, type DomainResult } from './index.js';

const expectValue = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.details)}`);
  return result.value;
};
const reason = (result: DomainResult<unknown>): unknown =>
  result.ok ? 'ok' : result.error.details?.['reason'];

const v2 = (items: unknown[]): unknown => ({ version: 2, items });

describe('TemplateBlueprint runtime contract', () => {
  it('decodes version 1 without reinterpretation and keeps its items unscheduled', () => {
    const blueprint = expectValue(
      parseTemplateBlueprint({
        version: 1,
        items: [
          { templateKey: 'p', kind: 'project', title: 'Launch' },
          { templateKey: 'a', kind: 'action', title: 'Draft', parentTemplateKey: 'p' },
        ],
      }),
    );
    expect(blueprint).toEqual({
      version: 1,
      items: [
        { templateKey: 'p', kind: 'project', title: 'Launch' },
        { templateKey: 'a', kind: 'action', title: 'Draft', parentTemplateKey: 'p' },
      ],
    });
    const preview = expectValue(
      previewTemplateApplication(blueprint, { anchorDate: '2026-08-10', timeZone: 'UTC' }),
    );
    expect(preview.items.map((item) => item.schedule)).toEqual([
      { kind: 'unscheduled' },
      { kind: 'unscheduled' },
    ]);
  });

  it('rejects V2 scheduling fields inside a version 1 blueprint', () => {
    expect(
      reason(
        parseTemplateBlueprint({
          version: 1,
          items: [{ templateKey: 'a', kind: 'action', title: 'A', relativeDayOffset: 1 }],
        }),
      ),
    ).toBe('unknown_field');
  });

  it('rejects unknown versions, dangling or invalid parents, duplicates, and limits', () => {
    expect(reason(parseTemplateBlueprint({ version: 3, items: [] }))).toBe('unsupported_version');
    expect(reason(parseTemplateBlueprint(v2([])))).toBe('item_count');
    expect(
      reason(
        parseTemplateBlueprint(
          v2([{ templateKey: 'a', kind: 'action', title: 'A', parentTemplateKey: 'missing' }]),
        ),
      ),
    ).toBe('dangling_parent');
    expect(
      reason(
        parseTemplateBlueprint(
          v2([
            { templateKey: 'a', kind: 'action', title: 'A' },
            { templateKey: 'n', kind: 'note', title: 'N', parentTemplateKey: 'a' },
          ]),
        ),
      ),
    ).toBe('parent_kind');
    expect(
      reason(
        parseTemplateBlueprint(
          v2([
            { templateKey: 'a', kind: 'action', title: 'A' },
            { templateKey: 'a', kind: 'action', title: 'B' },
          ]),
        ),
      ),
    ).toBe('duplicate_template_key');
    expect(
      reason(parseTemplateBlueprint(v2([{ templateKey: 'm', kind: 'milestone', title: 'M' }]))),
    ).toBe('milestone_requires_outcome');
    expect(
      reason(
        parseTemplateBlueprint(
          v2(
            Array.from({ length: 51 }, (_, index) => ({
              templateKey: `k${String(index)}`,
              kind: 'action',
              title: 'A',
            })),
          ),
        ),
      ),
    ).toBe('item_count');
    expect(
      reason(
        parseTemplateBlueprint(v2([{ templateKey: 'x'.repeat(51), kind: 'action', title: 'A' }])),
      ),
    ).toBe('template_key');
    expect(
      reason(
        parseTemplateBlueprint(v2([{ templateKey: 'a', kind: 'action', title: 'x'.repeat(201) }])),
      ),
    ).toBe('title');
  });

  it('requires a version 2 timed duration of at least the Time Block minimum', () => {
    const timed = (durationMinutes: number): unknown =>
      v2([
        {
          templateKey: 'a',
          kind: 'action',
          title: 'A',
          relativeDayOffset: 0,
          localStartTime: '09:00',
          durationMinutes,
        },
      ]);
    for (const minutes of [1, 3, 4, 1441])
      expect(reason(parseTemplateBlueprint(timed(minutes)))).toBe('duration_minutes');
    for (const minutes of [5, 1440])
      expect(reason(parseTemplateBlueprint(timed(minutes)))).toBe('ok');
  });

  it('validates scheduling dependencies and ranges', () => {
    expect(
      reason(
        parseTemplateBlueprint(
          v2([{ templateKey: 'a', kind: 'action', title: 'A', localStartTime: '09:00' }]),
        ),
      ),
    ).toBe('local_start_time_requires_offset');
    expect(
      reason(
        parseTemplateBlueprint(
          v2([
            {
              templateKey: 'a',
              kind: 'action',
              title: 'A',
              relativeDayOffset: 0,
              durationMinutes: 30,
            },
          ]),
        ),
      ),
    ).toBe('duration_requires_start_time');
    expect(
      reason(
        parseTemplateBlueprint(
          v2([{ templateKey: 'a', kind: 'action', title: 'A', relativeDayOffset: 366 }]),
        ),
      ),
    ).toBe('relative_day_offset');
    expect(
      reason(
        parseTemplateBlueprint(
          v2([
            {
              templateKey: 'a',
              kind: 'action',
              title: 'A',
              relativeDayOffset: 0,
              localStartTime: '25:00',
            },
          ]),
        ),
      ),
    ).toBe('local_start_time');
    expect(
      reason(
        parseTemplateBlueprint(
          v2([{ templateKey: 'n', kind: 'note', title: 'N', relativeDayOffset: 1 }]),
        ),
      ),
    ).toBe('scheduling_not_supported');
    expect(
      reason(
        parseTemplateBlueprint(
          v2([
            {
              templateKey: 'p',
              kind: 'project',
              title: 'P',
              relativeDayOffset: 1,
              localStartTime: '09:00',
            },
          ]),
        ),
      ),
    ).toBe('time_not_supported');
  });
});

describe('Template application preview', () => {
  const blueprint = expectValue(
    parseTemplateBlueprint(
      v2([
        { templateKey: 'project', kind: 'project', title: 'Sprint', relativeDayOffset: 0 },
        {
          templateKey: 'plan',
          kind: 'action',
          title: 'Plan sprint',
          parentTemplateKey: 'project',
          relativeDayOffset: 0,
          localStartTime: '09:00',
          durationMinutes: 45,
        },
        { templateKey: 'review', kind: 'action', title: 'Review', relativeDayOffset: 4 },
        { templateKey: 'loose', kind: 'action', title: 'Someday' },
      ]),
    ),
  );

  it('resolves exact dates, local times, and zone for the chosen anchor', () => {
    const preview = expectValue(
      previewTemplateApplication(blueprint, {
        anchorDate: '2026-08-10',
        timeZone: 'America/New_York',
      }),
    );
    expect(preview.timeZone).toBe('America/New_York');
    expect(preview.issues).toEqual([]);
    expect(preview.items.map((item) => item.schedule)).toEqual([
      { kind: 'date', date: '2026-08-10', placement: 'week' },
      {
        kind: 'timed',
        date: '2026-08-10',
        startsAt: '2026-08-10T13:00:00.000Z',
        endsAt: '2026-08-10T13:45:00.000Z',
        localStart: '09:00',
        localEnd: '09:45',
        endDate: '2026-08-10',
        utcOffset: '-04:00',
        durationMinutes: 45,
      },
      { kind: 'date', date: '2026-08-14', placement: 'day' },
      { kind: 'unscheduled' },
    ]);
  });

  it('follows the DST gap and repeated-time policies across boundaries', () => {
    const dst = expectValue(
      parseTemplateBlueprint(
        v2([
          {
            templateKey: 'gap',
            kind: 'action',
            title: 'Gap',
            relativeDayOffset: 0,
            localStartTime: '02:30',
            durationMinutes: 60,
          },
          {
            templateKey: 'repeat',
            kind: 'action',
            title: 'Repeat',
            relativeDayOffset: 238,
            localStartTime: '01:30',
            durationMinutes: 60,
          },
        ]),
      ),
    );
    const preview = expectValue(
      previewTemplateApplication(dst, { anchorDate: '2026-03-08', timeZone: 'America/New_York' }),
    );
    expect(preview.items[0]?.schedule).toMatchObject({
      kind: 'timed',
      startsAt: '2026-03-08T07:30:00.000Z',
      localStart: '03:30',
      utcOffset: '-04:00',
      adjustment: 'dst_gap_shifted',
    });
    expect(preview.items[1]?.schedule).toMatchObject({
      kind: 'timed',
      date: '2026-11-01',
      startsAt: '2026-11-01T05:30:00.000Z',
      localStart: '01:30',
      localEnd: '01:30',
      utcOffset: '-04:00',
      adjustment: 'dst_repeated_earlier',
    });
  });

  it('blocks a deselected parent with a selected child and allows a coherent subset', () => {
    const blocked = expectValue(
      previewTemplateApplication(blueprint, {
        anchorDate: '2026-08-10',
        timeZone: 'UTC',
        selectedKeys: new Set(['plan', 'review']),
      }),
    );
    expect(blocked.issues).toEqual([
      { code: 'parent_deselected', templateKey: 'plan', parentTemplateKey: 'project' },
    ]);
    const coherent = expectValue(
      previewTemplateApplication(blueprint, {
        anchorDate: '2026-08-10',
        timeZone: 'UTC',
        selectedKeys: new Set(['review', 'loose']),
      }),
    );
    expect(coherent.issues).toEqual([]);
    expect(coherent.selectedCount).toBe(2);
    const empty = expectValue(
      previewTemplateApplication(blueprint, {
        anchorDate: '2026-08-10',
        timeZone: 'UTC',
        selectedKeys: new Set(),
      }),
    );
    expect(empty.issues).toEqual([{ code: 'nothing_selected' }]);
  });

  it('requires kind-specific content and rejects unsupported selected kinds', () => {
    const special = expectValue(
      parseTemplateBlueprint(
        v2([
          { templateKey: 'o', kind: 'outcome', title: 'O' },
          { templateKey: 'm', kind: 'milestone', title: 'M', parentTemplateKey: 'o' },
          { templateKey: 'r', kind: 'routine', title: 'R' },
          { templateKey: 'c', kind: 'commitment', title: 'C', relativeDayOffset: 1 },
          {
            templateKey: 'd',
            kind: 'action',
            title: 'D',
            relativeDayOffset: 1,
            localStartTime: '09:00',
          },
        ]),
      ),
    );
    const preview = expectValue(
      previewTemplateApplication(special, { anchorDate: '2026-08-10', timeZone: 'UTC' }),
    );
    expect(preview.issues).toEqual([
      { code: 'success_definition_required', templateKey: 'o' },
      { code: 'checkpoint_required', templateKey: 'm' },
      { code: 'unsupported_kind', templateKey: 'r' },
      { code: 'commitment_time_required', templateKey: 'c' },
      { code: 'duration_required', templateKey: 'd' },
    ]);
  });

  it('rejects invalid anchors and zones', () => {
    expect(
      previewTemplateApplication(blueprint, { anchorDate: '2026-02-30', timeZone: 'UTC' }).ok,
    ).toBe(false);
    expect(
      previewTemplateApplication(blueprint, { anchorDate: '2026-08-10', timeZone: '+05:00' }).ok,
    ).toBe(false);
  });
});
