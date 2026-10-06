import { afterEach, describe, expect, it } from 'vitest';
import type { OwnerId, UUID } from '@yelaxis/domain';
import type { SearchRequest } from '@yelaxis/application';
import { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import { schemaMigrations } from '../sqlite/migrations';
import { runMigrations } from '../sqlite/migrations/migration';
import { searchMigration } from '../sqlite/migrations/015_search';
import { SqliteSearchQueries, buildSearchSql } from './sqlite-search-queries';

const at = '2026-10-03T12:00:00.000Z';
const owner = '10000000-0000-4000-8000-000000000001' as OwnerId;
const other = '10000000-0000-4000-8000-000000000002' as OwnerId;
const id = (prefix: number, n = 1) =>
  `${prefix}000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID;
const databases: NodeSqliteDriver[] = [];
afterEach(async () => {
  for (const driver of databases.splice(0)) await driver.close();
});
const request = (overrides: Partial<SearchRequest> = {}): SearchRequest => ({
  text: 'synthetic',
  archive: 'exclude',
  dateBasis: 'updated',
  ...overrides,
});
async function setup() {
  const driver = new NodeSqliteDriver(':memory:');
  databases.push(driver);
  await runMigrations(driver, [...schemaMigrations.slice(0, 14), searchMigration], () => at);
  const insert = async (table: string, row: Record<string, string | number | null>) => {
    const values = { created_at: at, updated_at: at, ...row };
    await driver.run(
      `INSERT INTO ${table}(${Object.keys(values).join(',')}) VALUES(${Object.keys(values)
        .map(() => '?')
        .join(',')})`,
      Object.values(values),
    );
  };
  for (const identity of [owner, other])
    await insert('planning_identities', { id: identity, identity_kind: 'local' });
  await insert('profiles', {
    id: id(11),
    owner_id: owner,
    planning_time_zone: 'Asia/Tashkent',
    week_start: 'monday',
  });
  await insert('axes', {
    id: id(12),
    owner_id: owner,
    title: 'Synthetic Axis',
    purpose: 'Steady pace',
    state: 'active',
    sort_key: 'a',
  });
  await insert('outcomes', {
    id: id(13),
    owner_id: owner,
    axis_id: id(12),
    title: 'Synthetic Outcome',
    success_definition: 'Visible recovery criteria',
    progress_mode: 'none',
    state: 'active',
    sort_key: 'a',
  });
  await insert('projects', {
    id: id(14),
    owner_id: owner,
    axis_id: id(12),
    title: 'Synthetic Project',
    description: 'Prose-only clue description',
    desired_result: 'Finished safely',
    notes: 'Private synthetic notes',
    state: 'active',
    sort_key: 'a',
  });
  await insert('milestones', {
    id: id(15),
    owner_id: owner,
    outcome_id: id(13),
    title: 'Synthetic Milestone',
    measurable_checkpoint: 'Measurable criterion',
    state: 'active',
    sort_key: 'a',
  });
  await insert('actions', {
    id: id(16),
    owner_id: owner,
    axis_id: id(12),
    project_id: id(14),
    title: 'Synthetic Action',
    note_text: 'CAFÉ—СЛОН full body ' + 'long prose '.repeat(80),
    state: 'inbox',
    due_date: '2026-10-09',
    sort_key: 'a',
  });
  await insert('actions', {
    id: id(16, 2),
    owner_id: owner,
    title: 'Synthetic archived',
    state: 'archived',
    state_before_archive: 'inbox',
    archived_at: at,
    sort_key: 'b',
  });
  await insert('actions', {
    id: id(16, 3),
    owner_id: other,
    title: 'Synthetic secret to another owner',
    state: 'inbox',
    sort_key: 'a',
  });
  await insert('actions', {
    id: id(16, 4),
    owner_id: owner,
    title: 'Synthetic deleted',
    state: 'inbox',
    deleted_at: at,
    sort_key: 'a',
  });
  await insert('notes', {
    id: id(17),
    owner_id: owner,
    axis_id: id(12),
    project_id: id(14),
    title: 'Synthetic Note',
    body: 'Markdown **raw prose** <script>synthetic</script>',
    state: 'active',
    sort_key: 'a',
  });
  await insert('routines', {
    id: id(18),
    owner_id: owner,
    axis_id: id(12),
    title: 'Synthetic Routine',
    description: 'Daily repetition',
    state: 'active',
    sort_key: 'a',
  });
  await insert('review_checkpoints', {
    id: id(19),
    owner_id: owner,
    profile_id: id(11),
    review_type: 'weekly',
    period_key: '2026-09-28',
    period_start_date: '2026-09-28',
    period_end_date: '2026-10-04',
    week_start: 'monday',
    notes: 'Synthetic reflections',
    state: 'draft',
  });
  await insert('review_items', {
    id: id(20),
    owner_id: owner,
    review_id: id(19),
    target_kind: 'action',
    action_id: id(16),
    decision: 'carry',
    decision_note: 'Synthetic decision note recovery',
    sort_key: 'a',
  });
  await insert('planning_placements', {
    id: id(21),
    owner_id: owner,
    action_id: id(16),
    horizon: 'day',
    period_key: '2026-10-06',
    period_start_date: '2026-10-06',
    period_end_date: '2026-10-06',
    sort_key: 'a',
  });
  return { driver, insert, queries: new SqliteSearchQueries(driver) };
}
describe('real SQLite indexed local Search', () => {
  it.each([
    ['actions', 'note_text', 'action', id(16)],
    ['notes', 'body', 'note', id(17)],
    ['axes', 'purpose', 'axis', id(12)],
    ['outcomes', 'success_definition', 'outcome', id(13)],
    ['projects', 'notes', 'project', id(14)],
    ['milestones', 'measurable_checkpoint', 'milestone', id(15)],
    ['routines', 'description', 'routine', id(18)],
    ['review_checkpoints', 'notes', 'review', id(19)],
    ['review_items', 'decision_note', 'review_decision', id(20)],
  ] as const)(
    'allows canonical %s text updates with repeated normalized words',
    async (table, column, kind, entityId) => {
      const { driver, queries } = await setup();
      await driver.transaction(async (tx) => {
        await tx.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [
          'echo echo CAFÉ cafe\u0301',
          entityId,
        ]);
      });
      expect(
        (await queries.search(owner, request({ text: 'echo café', kind }), 40)).items.map(
          (row) => row.id,
        ),
      ).toEqual([entityId]);
      expect(
        await driver.get(
          'SELECT COUNT(*) AS count FROM search_tokens WHERE owner_id = ? AND kind = ? AND entity_id = ? AND token = ?',
          [owner, kind, entityId, 'echo'],
        ),
      ).toEqual({ count: 1 });
      expect(
        await driver.get(
          'SELECT COUNT(*) AS count FROM search_tokens WHERE owner_id = ? AND kind = ? AND entity_id = ? AND token = ?',
          [owner, kind, entityId, 'café'],
        ),
      ).toEqual({ count: 1 });
      await driver.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [
        'replacement replacement',
        entityId,
      ]);
      expect((await queries.search(owner, request({ text: 'echo', kind }), 40)).items).toEqual([]);
      expect(
        (await queries.search(owner, request({ text: 'replacement', kind }), 40)).items.map(
          (row) => row.id,
        ),
      ).toEqual([entityId]);
      expect(await driver.all('PRAGMA foreign_key_check')).toEqual([]);
    },
  );

  it('covers canonical titles and related prose, all entity types, normalized prefix words, and full details', async () => {
    const { queries } = await setup();
    const all = await queries.search(owner, request(), 40);
    expect(all.items).toHaveLength(9);
    expect(new Set(all.items.map((row) => row.kind))).toEqual(
      new Set([
        'action',
        'note',
        'axis',
        'outcome',
        'project',
        'milestone',
        'routine',
        'review',
        'review_decision',
      ]),
    );
    expect(
      (await queries.search(owner, request({ text: 'cafe\u0301 сло' }), 40)).items.map(
        (row) => row.id,
      ),
    ).toEqual([id(16)]);
    expect(
      (await queries.search(owner, request({ text: 'prose-only clue' }), 40)).items.map(
        (row) => row.id,
      ),
    ).toEqual([id(14)]);
    const detail = await queries.detail(owner, 'action', id(16));
    expect(detail?.text).toContain('long prose '.repeat(80));
    expect(all.items.find((row) => row.kind === 'action')?.excerpt.length).toBeLessThanOrEqual(201);
    expect(await queries.detail(owner, 'action', id(16, 3))).toBeNull();
    expect(await queries.detail(owner, 'action', id(16, 4))).toBeNull();
    expect((await queries.search(owner, request({ text: "% ' OR 1=1 --" }), 40)).items).toEqual([]);
  });
  it('combines state, dates, Axis, Project, type, and archive filters without accessing deleted or other owners', async () => {
    const { queries } = await setup();
    expect(
      (
        await queries.search(
          owner,
          request({
            kind: 'action',
            state: 'inbox',
            axisId: id(12),
            projectId: id(14),
            from: '2026-10-03' as never,
            to: '2026-10-03' as never,
          }),
          40,
        )
      ).items.map((row) => row.id),
    ).toEqual([id(16)]);
    expect(
      (
        await queries.search(
          owner,
          request({
            kind: 'action',
            dateBasis: 'due',
            from: '2026-10-09' as never,
            to: '2026-10-09' as never,
          }),
          40,
        )
      ).items.map((row) => row.id),
    ).toEqual([id(16)]);
    expect(
      (
        await queries.search(
          owner,
          request({
            kind: 'action',
            dateBasis: 'planned',
            from: '2026-10-06' as never,
            to: '2026-10-06' as never,
          }),
          40,
        )
      ).items.map((row) => row.id),
    ).toEqual([id(16)]);
    expect(
      (
        await queries.search(
          owner,
          request({ dateBasis: 'created', to: '2026-10-02' as never }),
          40,
        )
      ).items,
    ).toEqual([]);
    expect(
      (await queries.search(owner, request({ archive: 'only' }), 40)).items.map((row) => row.id),
    ).toEqual([id(16, 2)]);
    expect((await queries.search(owner, request({ archive: 'include' }), 40)).items).toHaveLength(
      10,
    );
    expect(
      (await queries.search(owner, request({ axisId: id(12), kind: 'milestone' }), 40)).items.map(
        (row) => row.id,
      ),
    ).toEqual([id(15)]);
    expect(
      (
        await queries.search(owner, request({ projectId: id(14), kind: 'review_decision' }), 40)
      ).items.map((row) => row.id),
    ).toEqual([id(20)]);
    expect(await queries.choices(owner, 1000)).toEqual({
      axes: [{ id: id(12), title: 'Synthetic Axis' }],
      projects: [{ id: id(14), title: 'Synthetic Project' }],
      truncated: false,
    });
  });
  it('keeps parent-dependent decisions and inherited Milestone Axis filters consistent', async () => {
    const { queries, driver, insert } = await setup();
    await insert('axes', {
      id: id(12, 2),
      owner_id: owner,
      title: 'Another Axis',
      state: 'active',
      sort_key: 'b',
    });
    await driver.run('UPDATE outcomes SET axis_id = ? WHERE id = ?', [id(12, 2), id(13)]);
    expect(
      (
        await queries.search(owner, request({ axisId: id(12, 2), kind: 'milestone' }), 40)
      ).items.map((row) => row.id),
    ).toEqual([id(15)]);
    await driver.run('UPDATE actions SET axis_id = ?, project_id = NULL WHERE id = ?', [
      id(12, 2),
      id(16),
    ]);
    expect(
      (
        await queries.search(owner, request({ axisId: id(12, 2), kind: 'review_decision' }), 40)
      ).items.map((row) => row.id),
    ).toEqual([id(20)]);
    expect(
      (await queries.search(owner, request({ projectId: id(14), kind: 'review_decision' }), 40))
        .items,
    ).toEqual([]);
    await driver.run(
      'UPDATE review_checkpoints SET state = ?,state_before_archive = ?,archived_at = ? WHERE id = ?',
      ['archived', 'draft', at, id(19)],
    );
    expect((await queries.search(owner, request({ kind: 'review_decision' }), 40)).items).toEqual(
      [],
    );
    expect(
      (await queries.search(owner, request({ kind: 'review_decision', archive: 'only' }), 40))
        .items,
    ).toHaveLength(1);
    await driver.run('UPDATE review_checkpoints SET deleted_at = ? WHERE id = ?', [at, id(19)]);
    expect(await queries.detail(owner, 'review_decision', id(20))).toBeNull();
  });
  it('uses stable bounded cursor pages and refuses a cursor for different filters', async () => {
    const { queries } = await setup();
    const first = await queries.search(owner, request(), 3);
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toBeDefined();
    const cursor = first.nextCursor;
    if (cursor === undefined) throw new Error('Missing pagination cursor');
    const second = await queries.search(owner, request({ cursor }), 3);
    expect(new Set([...first.items, ...second.items].map((row) => row.kind + row.id)).size).toBe(6);
    await expect(queries.search(owner, request({ text: 'other', cursor }), 3)).rejects.toThrow(
      'Search filters',
    );
  });
  it.each([
    request(),
    request({ text: 'synthetic recovery' }),
    request({ text: '', state: 'inbox' }),
    request({ text: '', axisId: id(12) }),
    request({ text: '', projectId: id(14) }),
    request({ text: '', dateBasis: 'created', from: '2026-10-03' as never }),
    request({ text: '', dateBasis: 'due', from: '2026-10-03' as never }),
    request({ text: '', dateBasis: 'planned', from: '2026-10-06' as never }),
  ])('requires indexed owner-scoped lookup and bounded SQL for %j', async (filters) => {
    const { driver } = await setup();
    const query = buildSearchSql(owner, filters, 40);
    const plan = await driver.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${query.sql}`,
      query.parameters,
    );
    const text = plan.map((row) => row.detail).join('\n');
    expect(text).toMatch(
      /SEARCH (?:d|search_tokens|p) USING (?:INDEX|COVERING INDEX|PRIMARY KEY)/u,
    );
    expect(text).not.toMatch(
      /SCAN (?:actions|notes|projects|outcomes|review_items|review_checkpoints|d|search_tokens|p)(?:\s|$)/u,
    );
    expect(query.sql).toContain('LIMIT ?');
    expect(query.parameters.at(-1)).toBe(41);
  });
});
