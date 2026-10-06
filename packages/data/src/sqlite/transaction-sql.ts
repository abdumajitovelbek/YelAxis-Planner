const transactionControlKeywords = new Set([
  'BEGIN',
  'COMMIT',
  'END',
  'RELEASE',
  'ROLLBACK',
  'SAVEPOINT',
]);

/** Reject transaction control on application-scoped prepared statement APIs. */
export function assertTransactionStatementAllowed(sql: string): void {
  let remaining = sql;
  while (true) {
    remaining = remaining.trimStart();
    if (remaining.startsWith('--')) {
      const newline = remaining.search(/[\r\n]/u);
      remaining = newline < 0 ? '' : remaining.slice(newline + 1);
      continue;
    }
    if (remaining.startsWith('/*')) {
      const end = remaining.indexOf('*/', 2);
      remaining = end < 0 ? '' : remaining.slice(end + 2);
      continue;
    }
    if (remaining.startsWith(';')) {
      remaining = remaining.slice(1);
      continue;
    }
    break;
  }

  const keyword = /^[A-Za-z]+/u.exec(remaining)?.[0]?.toUpperCase();
  if (keyword !== undefined && transactionControlKeywords.has(keyword)) {
    throw new Error('SQLite transaction control is adapter-owned');
  }
}
