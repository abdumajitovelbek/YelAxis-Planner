import { parseTemplateBlueprint, type TemplateBlueprint } from '@yelaxis/domain';

import type { CanonicalSnapshotRecord } from './account-contracts';

/** RFC 4180 cell. Formula-like prose is made literal when opened in spreadsheet software. */
export function csvCell(value: unknown): string {
  let text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '';
  if (typeof value === 'string' && /^[\t\r\n ]*[=+@-]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export const actionCsvHeaders = Object.freeze([
  'id',
  'title',
  'state',
  'note',
  'axis_id',
  'project_id',
  'due_date',
  'due_at_utc',
  'due_time_zone',
  'estimate_minutes',
  'energy',
  'priority',
  'completed_at_utc',
  'archived_at_utc',
]);
export const blockCsvHeaders = Object.freeze([
  'id',
  'title',
  'state',
  'target_kind',
  'action_id',
  'commitment_id',
  'routine_occurrence_id',
  'starts_at_utc',
  'ends_at_utc',
  'time_zone',
  'note',
  'archived_at_utc',
]);

const recordsOf = (
  records: readonly CanonicalSnapshotRecord[],
  type: CanonicalSnapshotRecord['type'],
) =>
  records
    .filter((record) => record.type === type)
    .sort((left, right) => left.id.localeCompare(right.id));

export function exportActionsCsv(records: readonly CanonicalSnapshotRecord[]): string {
  return csv(
    actionCsvHeaders,
    recordsOf(records, 'action').map(({ id, document: d }) => {
      const due = object(d['due']);
      return [
        id,
        d['title'],
        d['state'],
        d['note'],
        d['axisId'],
        d['projectId'],
        due['date'],
        due['instant'],
        due['authoredTimeZone'],
        d['estimateMinutes'],
        d['energy'],
        d['priority'],
        d['completedAt'],
        d['archivedAt'],
      ];
    }),
  );
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function exportBlocksCsv(records: readonly CanonicalSnapshotRecord[]): string {
  return csv(
    blockCsvHeaders,
    recordsOf(records, 'time_block').map(({ id, document: d }) => {
      const target = object(d['target']);
      return [
        id,
        d['label'] ?? d['title'] ?? target['label'] ?? target['title'],
        d['state'],
        target['kind'],
        target['actionId'],
        target['commitmentId'],
        target['routineOccurrenceId'],
        d['startsAt'],
        d['endsAt'],
        d['timeZone'],
        d['note'],
        d['archivedAt'],
      ];
    }),
  );
}

/** Text is preserved as prose, with Markdown/HTML control characters escaped. */
function markdown(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\\`*_{}[\]()#+!|~]/gu, '\\$&');
}

export function exportReviewsMarkdown(records: readonly CanonicalSnapshotRecord[]): string {
  const reviews = recordsOf(records, 'review').sort(
    (left, right) =>
      String(left.document['periodStart']).localeCompare(String(right.document['periodStart'])) ||
      left.id.localeCompare(right.id),
  );
  const lines = [
    '# YelAxis Planner reviews',
    '',
    'Readable private data. This export is not a restore format.',
    '',
  ];
  for (const { id, document: d } of reviews) {
    lines.push(
      `## ${markdown(d['reviewType'])} — ${markdown(d['periodKey'])}`,
      '',
      `State: ${markdown(d['state'])}`,
      '',
    );
    lines.push(`Period: ${markdown(d['periodStart'])} through ${markdown(d['periodEnd'])}`, '');
    if (d['energy'] !== undefined) lines.push(`Energy: ${markdown(d['energy'])}`, '');
    if (d['notes'] !== undefined) lines.push(markdown(d['notes']), '');
    if (d['themeText'] !== undefined) lines.push(`Theme: ${markdown(d['themeText'])}`, '');
    if (d['directionChoice'] !== undefined)
      lines.push(
        `Direction: ${markdown(d['directionChoice'])} ${markdown(d['directionText'])}`,
        '',
      );
    const items = recordsOf(records, 'review_item').filter(
      ({ document }) => document['reviewId'] === id,
    );
    for (const { document: item } of items) {
      const target = object(item['target']);
      const kind = target['kind'] ?? item['targetKind'] ?? 'object';
      const targetId =
        target['actionId'] ??
        target['axisId'] ??
        target['projectId'] ??
        target['outcomeId'] ??
        target['milestoneId'] ??
        target['routineId'];
      lines.push(
        `- ${markdown(kind)}${targetId === undefined ? '' : ` (${markdown(targetId)})`}: ${markdown(item['decision'])}`,
      );
      if (item['period'] !== undefined)
        lines.push(`  Move to: ${markdown(JSON.stringify(item['period']))}`);
      if (target['period'] !== undefined)
        lines.push(`  Occurrence period: ${markdown(JSON.stringify(target['period']))}`);
      if (item['note'] !== undefined || item['notes'] !== undefined)
        lines.push(`  ${markdown(item['note'] ?? item['notes']).replaceAll('\n', '\n  ')}`);
      if (item['detail'] !== undefined) {
        const detail = object(item['detail']);
        for (const [field, value] of Object.entries(detail))
          if (['string', 'number', 'boolean'].includes(typeof value))
            lines.push(`  ${markdown(field)}: ${markdown(String(value))}`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** A Template file carries structure only; saving/applying still uses the normal preview commands. */
export function exportTemplate(title: string, blueprint: TemplateBlueprint): string {
  const parsed = parseTemplateBlueprint(blueprint);
  if (!parsed.ok || title.trim().length === 0 || title.length > 200)
    throw new Error('invalid_template');
  return `${JSON.stringify({ format: 'yelaxis.template', formatVersion: 1, title: title.trim(), blueprint: parsed.value }, null, 2)}\n`;
}

export type TemplateExportResult =
  | {
      readonly ok: true;
      readonly value: { readonly title: string; readonly blueprint: TemplateBlueprint };
    }
  | { readonly ok: false };

export function readTemplateExport(text: string): TemplateExportResult {
  if (new TextEncoder().encode(text).byteLength > 1_048_576) return { ok: false };
  try {
    const value: unknown = JSON.parse(text);
    const data = object(value);
    if (
      Object.keys(data).sort().join(',') !== 'blueprint,format,formatVersion,title' ||
      data['format'] !== 'yelaxis.template' ||
      data['formatVersion'] !== 1 ||
      typeof data['title'] !== 'string' ||
      data['title'].trim().length === 0 ||
      data['title'].length > 200
    )
      return { ok: false };
    const blueprint = parseTemplateBlueprint(data['blueprint']);
    if (!blueprint.ok) return { ok: false };
    return { ok: true, value: { title: data['title'].trim(), blueprint: blueprint.value } };
  } catch {
    return { ok: false };
  }
}
