const transactionControlKeywords = new Set([
  'BEGIN',
  'COMMIT',
  'END',
  'RELEASE',
  'ROLLBACK',
  'SAVEPOINT',
]);

type SqlToken = { readonly kind: 'word'; readonly value: string } | { readonly kind: 'semicolon' };

/** Finds transaction control only when it begins a top-level SQLite statement. */
export function containsTopLevelTransactionControl(sql: string): boolean {
  let atStatementStart = true;
  let statementPrefix: string[] = [];
  let isTrigger = false;
  let inTriggerBody = false;
  let triggerEndPending = false;
  let caseDepth = 0;

  for (const token of tokenizeSql(sql)) {
    if (atStatementStart) {
      if (token.kind === 'semicolon') continue;
      if (transactionControlKeywords.has(token.value)) return true;
      atStatementStart = false;
      statementPrefix = [token.value];
      continue;
    }

    if (token.kind === 'semicolon') {
      if (!inTriggerBody || triggerEndPending) {
        atStatementStart = true;
        statementPrefix = [];
        isTrigger = false;
        inTriggerBody = false;
        triggerEndPending = false;
        caseDepth = 0;
      }
      continue;
    }

    if (!inTriggerBody) {
      if (statementPrefix.length < 3) statementPrefix.push(token.value);
      isTrigger = isCreateTriggerPrefix(statementPrefix);
      if (isTrigger && token.value === 'BEGIN') inTriggerBody = true;
      continue;
    }

    if (token.value === 'CASE') {
      caseDepth += 1;
    } else if (token.value === 'END') {
      if (caseDepth > 0) caseDepth -= 1;
      else triggerEndPending = true;
    }
  }

  return false;
}

function isCreateTriggerPrefix(words: readonly string[]): boolean {
  return (
    words[0] === 'CREATE' &&
    (words[1] === 'TRIGGER' ||
      ((words[1] === 'TEMP' || words[1] === 'TEMPORARY') && words[2] === 'TRIGGER'))
  );
}

function* tokenizeSql(sql: string): Generator<SqlToken> {
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index = Math.min(index + 2, sql.length);
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      index = skipQuoted(sql, index, character);
      continue;
    }
    if (character === '[') {
      index += 1;
      while (index < sql.length && sql[index] !== ']') index += 1;
      index = Math.min(index + 1, sql.length);
      continue;
    }
    if (character === ';') {
      yield { kind: 'semicolon' };
      index += 1;
      continue;
    }
    if (character !== undefined && /[A-Za-z_]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/u.test(sql[index] ?? '')) index += 1;
      yield { kind: 'word', value: sql.slice(start, index).toUpperCase() };
      continue;
    }
    index += 1;
  }
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== quote) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return sql.length;
}
