import type {
  SearchDateBasis,
  SearchDetail,
  SearchEntityKind,
  SearchFilterChoices,
  SearchPage,
  SearchQueryPort,
  SearchRequest,
  SearchSummary,
} from '@yelaxis/application';
import type { OwnerId, UUID } from '@yelaxis/domain';
import type { SqliteParameter, SqliteQueryConnection } from '../sqlite/driver';
import { normalizeSearchText } from './search-normalization';

interface DocumentRow {
  readonly kind: SearchEntityKind;
  readonly entity_id: UUID;
  readonly title: string;
  readonly text_value: string;
  readonly state: string;
  readonly archived: number;
  readonly axis_id: UUID | null;
  readonly project_id: UUID | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly review_type: NonNullable<SearchDetail['review']>['type'] | null;
  readonly review_key: string | null;
}

function queryHash(request: SearchRequest): string {
  const normalized = { ...request, text: normalizeSearchText(request.text), cursor: undefined };
  const value = JSON.stringify(normalized);
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
/** Inclusive prefix start and exclusive prefix successor work for every Unicode code point. */
function prefixEnd(token: string): string {
  const points = [...token];
  const last = points.pop();
  return points.join('') + String.fromCodePoint((last?.codePointAt(0) ?? 0) + 1);
}
function dateColumn(basis: SearchDateBasis): string {
  return basis === 'created' ? 'd.created_at' : basis === 'due' ? 'd.due_date' : 'd.updated_at';
}

export function buildSearchSql(
  ownerId: OwnerId,
  request: SearchRequest,
  limit: number,
): {
  readonly sql: string;
  readonly parameters: readonly SqliteParameter[];
} {
  const terms = [...new Set(normalizeSearchText(request.text).split(' ').filter(Boolean))];
  const parameters: SqliteParameter[] = [];
  const conditions = ['d.owner_id = ?'];
  let withSql = '';
  let joins = '';
  if (terms.length > 0) {
    withSql = `WITH matches AS (${terms
      .map((term) => {
        parameters.push(ownerId, term, prefixEnd(term));
        return 'SELECT kind, entity_id FROM search_tokens WHERE owner_id = ? AND token >= ? AND token < ?';
      })
      .join(' INTERSECT ')})`;
    joins = 'JOIN matches ON matches.kind = d.kind AND matches.entity_id = d.entity_id';
  } else if (request.text.trim() !== '') {
    conditions.push('0');
  }
  parameters.push(ownerId);
  if (request.archive !== 'include') {
    conditions.push('d.archived = ?');
    parameters.push(request.archive === 'only' ? 1 : 0);
  }
  for (const [field, column] of [
    ['kind', 'kind'],
    ['state', 'state'],
    ['axisId', 'axis_id'],
    ['projectId', 'project_id'],
  ] as const) {
    const value = request[field];
    if (value === undefined) continue;
    conditions.push(`d.${column} = ?`);
    parameters.push(value);
  }
  if (request.dateBasis === 'planned' && (request.from !== undefined || request.to !== undefined)) {
    // Active explicit placements are indexed by owner/date. Their period overlaps the chosen dates.
    const dates = ['p.owner_id = d.owner_id', 'p.archived_at IS NULL', 'p.deleted_at IS NULL'];
    if (request.from !== undefined) {
      dates.push('p.period_end_date >= ?');
      parameters.push(request.from);
    }
    if (request.to !== undefined) {
      dates.push('p.period_start_date <= ?');
      parameters.push(request.to);
    }
    conditions.push(`EXISTS (SELECT 1 FROM planning_placements p INDEXED BY idx_search_placements_dates WHERE ${dates.join(' AND ')} AND (
      (d.kind = 'action' AND p.action_id = d.entity_id) OR
      (d.kind = 'project' AND p.project_id = d.entity_id) OR
      (d.kind = 'outcome' AND p.outcome_id = d.entity_id) OR
      (d.kind = 'milestone' AND p.milestone_id = d.entity_id)))`);
  } else {
    const column = dateColumn(request.dateBasis);
    if (request.from !== undefined) {
      conditions.push(`${column} >= ?`);
      parameters.push(request.from);
    }
    if (request.to !== undefined) {
      conditions.push(`${column} <= ?`);
      parameters.push(request.dateBasis === 'due' ? request.to : `${request.to}T23:59:59.999Z`);
    }
  }
  if (request.cursor !== undefined) {
    const parts =
      /^s1\.([0-9a-f]{8})\.(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\.([a-z_]+)\.([0-9a-f-]{36})$/u.exec(
        request.cursor,
      );
    if (parts === null || parts[1] !== queryHash(request))
      throw new Error('Search filters changed. Start from the first page.');
    const at = parts[2] ?? '';
    const kind = parts[3] ?? '';
    const id = parts[4] ?? '';
    conditions.push(
      '(d.updated_at < ? OR (d.updated_at = ? AND d.kind > ?) OR (d.updated_at = ? AND d.kind = ? AND d.entity_id > ?))',
    );
    parameters.push(at, at, kind, at, kind, id);
  }
  parameters.push(Math.min(Math.max(Math.trunc(limit), 1), 100) + 1);
  return {
    sql: `${withSql} SELECT d.kind, d.entity_id, d.title, substr(d.text_value, 1, 200) AS text_value, d.state, d.archived, d.updated_at
      FROM search_documents d ${joins} WHERE ${conditions.join(' AND ')}
      ORDER BY d.updated_at DESC, d.kind, d.entity_id LIMIT ?`,
    parameters,
  };
}

function summary(row: DocumentRow): SearchSummary {
  return {
    kind: row.kind,
    id: row.entity_id,
    title: row.title,
    excerpt: row.text_value,
    state: row.state,
    archived: row.archived === 1,
    updatedAt: row.updated_at,
  };
}

/** Worker-backed read adapter; never writes canonical rows or stores query text. */
export class SqliteSearchQueries implements SearchQueryPort {
  constructor(private readonly connection: SqliteQueryConnection) {}
  async search(ownerId: OwnerId, request: SearchRequest, limit: number): Promise<SearchPage> {
    const query = buildSearchSql(ownerId, request, limit);
    const rows = await this.connection.all<DocumentRow>(query.sql, query.parameters);
    const pageSize = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const items = rows.slice(0, pageSize).map(summary);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > pageSize && last !== undefined
        ? { nextCursor: `s1.${queryHash(request)}.${last.updatedAt}.${last.kind}.${last.id}` }
        : {}),
    };
  }
  async detail(ownerId: OwnerId, kind: SearchEntityKind, id: UUID): Promise<SearchDetail | null> {
    const row = await this.connection.get<DocumentRow>(
      'SELECT * FROM search_documents WHERE owner_id = ? AND kind = ? AND entity_id = ?',
      [ownerId, kind, id],
    );
    if (row === undefined) return null;
    return {
      kind: row.kind,
      id: row.entity_id,
      title: row.title,
      state: row.state,
      archived: row.archived === 1,
      updatedAt: row.updated_at,
      text: row.text_value,
      createdAt: row.created_at,
      ...(row.axis_id === null ? {} : { axisId: row.axis_id }),
      ...(row.project_id === null ? {} : { projectId: row.project_id }),
      ...(row.review_type === null || row.review_key === null
        ? {}
        : { review: { type: row.review_type, key: row.review_key } }),
    };
  }
  async choices(ownerId: OwnerId, limit: number): Promise<SearchFilterChoices> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 1000);
    const axes = await this.connection.all<{ id: UUID; title: string }>(
      "SELECT entity_id AS id, title FROM search_documents WHERE owner_id = ? AND kind = 'axis' ORDER BY title, entity_id LIMIT ?",
      [ownerId, bounded + 1],
    );
    const projects = await this.connection.all<{ id: UUID; title: string }>(
      "SELECT entity_id AS id, title FROM search_documents WHERE owner_id = ? AND kind = 'project' ORDER BY title, entity_id LIMIT ?",
      [ownerId, bounded + 1],
    );
    return {
      axes: axes.slice(0, bounded),
      projects: projects.slice(0, bounded),
      truncated: axes.length > bounded || projects.length > bounded,
    };
  }
}
