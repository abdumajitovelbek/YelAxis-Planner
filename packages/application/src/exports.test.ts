import { describe, expect, it } from 'vitest';

import {
  csvCell,
  exportActionsCsv,
  exportBlocksCsv,
  exportReviewsMarkdown,
  exportTemplate,
  readTemplateExport,
} from './exports';
import type { CanonicalSnapshotRecord } from './account-contracts';
import type { UUID } from '@yelaxis/domain';

const id = '10000000-0000-4000-8000-000000000001' as UUID;
const record = (
  type: CanonicalSnapshotRecord['type'],
  document: Record<string, unknown>,
): CanonicalSnapshotRecord => ({ type, id, localRevision: 1, document });

describe('offline convenience exports', () => {
  it('quotes RFC 4180 multiline cells and neutralizes spreadsheet formulas without changing ordinary numbers', () => {
    expect(csvCell('one,"two"\nthree')).toBe('"one,""two""\nthree"');
    expect(csvCell('=HYPERLINK("https://example.test")')).toBe(
      '"\'=HYPERLINK(""https://example.test"")"',
    );
    expect(csvCell('\t+command')).toBe("'\t+command");
    expect(csvCell(120)).toBe('120');
  });
  it('exports stable Action IDs, UTC due instants, full Unicode notes, and no owner or operational data', () => {
    const text = exportActionsCsv([
      record('action', {
        title: 'كتابة 日本語',
        note: 'Line 1\nLine 2',
        state: 'inbox',
        due: {
          kind: 'instant',
          instant: '2026-10-03T14:00:00.000Z',
          authoredTimeZone: 'Asia/Tashkent',
        },
        ownerId: 'never-export',
        estimateMinutes: 20,
      }),
    ]);
    expect(text).toContain(
      'id,title,state,note,axis_id,project_id,due_date,due_at_utc,due_time_zone,estimate_minutes',
    );
    expect(text).toContain('كتابة 日本語');
    expect(text).toContain('"Line 1\nLine 2"');
    expect(text).toContain('2026-10-03T14:00:00.000Z');
    expect(text).not.toContain('never-export');
    expect(text.endsWith('\r\n')).toBe(true);
  });
  it('exports fixed block UTC instants and their authoring zone separately', () => {
    const text = exportBlocksCsv([
      record('time_block', {
        title: 'Walk',
        target: { kind: 'custom', title: 'Walk' },
        state: 'planned',
        startsAt: '2026-10-03T14:00:00.000Z',
        endsAt: '2026-10-03T14:30:00.000Z',
        timeZone: 'Asia/Tashkent',
      }),
    ]);
    expect(text).toContain('2026-10-03T14:00:00.000Z');
    expect(text).toContain('Asia/Tashkent');
    expect(text).not.toContain('19:00');
  });
  it('exports exact review periods, full notes and decisions in chronological order as escaped Markdown', () => {
    const text = exportReviewsMarkdown([
      record('review', {
        reviewType: 'weekly',
        periodKey: '2026-10-05',
        periodStart: '2026-10-05',
        periodEnd: '2026-10-11',
        state: 'completed',
        notes: '# Private <script>',
      }),
      {
        ...record('review_item', {
          reviewId: id,
          decision: 'continue',
          notes: 'Keep *care*',
          target: { kind: 'action', actionId: id },
        }),
        id: '10000000-0000-4000-8000-000000000002' as UUID,
      },
    ]);
    expect(text).toContain('2026-10-05');
    expect(text).toContain('Period: 2026-10-05 through 2026-10-11');
    expect(text).toContain('completed');
    expect(text).toContain('continue');
    expect(text).toContain('Keep \\*care\\*');
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('owner_id');
  });
  it('exports Template structure only and rejects unknown envelopes or private authority', () => {
    const blueprint = {
      version: 2 as const,
      items: [{ templateKey: 'a', kind: 'action' as const, title: 'Walk', relativeDayOffset: 1 }],
    };
    const file = exportTemplate('Morning', blueprint);
    expect(readTemplateExport(file)).toMatchObject({
      ok: true,
      value: { title: 'Morning', blueprint },
    });
    expect(file).not.toContain(id);
    expect(file).not.toContain('owner');
    expect(readTemplateExport(file.replace('"formatVersion": 1', '"formatVersion": 2')).ok).toBe(
      false,
    );
    const malicious = JSON.parse(file) as Record<string, unknown>;
    malicious['ownerId'] = id;
    expect(readTemplateExport(JSON.stringify(malicious)).ok).toBe(false);
    expect(readTemplateExport('x'.repeat(1_048_577)).ok).toBe(false);
  });
});
