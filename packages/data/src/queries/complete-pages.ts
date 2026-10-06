import type { SqliteDriver, SqliteParameter } from '../sqlite/driver';

/**
 * Exhaust a stable read using bounded keyset pages. Application query queues exclude writes
 * between these pages. The final key must be unique; SQL identifiers come only from adapter code.
 * This bounds each worker response without treating a page size as a limit on the user's plan.
 */
export async function completePages<Row extends Readonly<Record<string, unknown>>>(
  driver: SqliteDriver,
  sql: string,
  parameters: readonly SqliteParameter[],
  keys: readonly Readonly<{ column: string; result: string }>[],
  compound = false,
): Promise<Row[]> {
  const limit = /LIMIT (\d+);\s*$/u.exec(sql);
  if (limit === null || keys.length === 0)
    throw new Error('A complete read requires a fixed page and stable keys.');
  const pageSize = Number(limit[1]);
  const orderStart = sql.lastIndexOf('ORDER BY');
  if (orderStart < 0) throw new Error('A complete read requires a stable order.');
  const body = sql.slice(0, orderStart);
  const order = sql.slice(orderStart);
  const union = compound;
  const columns = keys.map((key) => (union ? key.result : key.column)).join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  const nextSql = union
    ? `SELECT * FROM (${body}) WHERE (${columns}) > (${placeholders}) ${order}`
    : `${body} AND (${columns}) > (${placeholders}) ${order}`;
  const output: Row[] = [];
  let cursor: SqliteParameter[] | undefined;
  for (;;) {
    const rows = await driver.all<Row>(
      cursor === undefined ? sql : nextSql,
      cursor === undefined ? parameters : [...parameters, ...cursor],
    );
    output.push(...rows);
    if (rows.length < pageSize) return output;
    const last = rows.at(-1);
    if (last === undefined) return output;
    cursor = keys.map((key) => {
      const value = last[key.result];
      if (typeof value !== 'string' && typeof value !== 'number')
        throw new Error('A complete read has an invalid cursor.');
      return value;
    });
  }
}
