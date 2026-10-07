/** Query formatting is separate from the CLI's legacy status-output flag. */
export function catalogQueryArguments(workdir: string, sql: string): string[] {
  return [
    'db',
    'query',
    '--local',
    '--workdir',
    workdir,
    '--output-format',
    'json',
    '--agent',
    'no',
    sql,
  ];
}

/** Verification must reject unknown output rather than interpreting it as an empty database. */
export function parseCatalogRows(output: string): Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(output);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !('rows' in parsed) ||
      !Array.isArray(parsed.rows) ||
      parsed.rows.some(
        (row: unknown) => row === null || typeof row !== 'object' || Array.isArray(row),
      )
    )
      throw new Error();
    return parsed.rows as Record<string, unknown>[];
  } catch {
    // CLI output can contain connection details. Keep the error fixed and content-free.
    throw new Error('The local catalog query returned an unsupported result format.');
  }
}
